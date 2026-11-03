import { annotate, defineTool, getVariable, setVariable, tool, useCase, withItem } from '@mt/core'
import type { ComposableTool, Exchange, Tool, ToolContext } from '@mt/core'
import {
  DEFAULT_CHUNK_CONCURRENCY,
  PROMPT_OVERHEAD_SLACK_TOKENS,
  TRANSLATE_PREFIX_FALLBACK_TOKENS,
  TRANSLATE_SYSTEM_FALLBACK_TOKENS,
} from '../constants.js'
import { countTextTokens } from '../normalization/token-counter.js'
import { cleanTranslation } from '../normalization/translation-prompt.js'
import { resolveTunedNum } from '../resolve-constants.js'
import {
  type ChunkBudget,
  DEFAULT_OUTPUT_RESERVE,
  type SemanticUnit,
  adaptiveSemanticChunks,
  estimateOverhead,
  processChunks,
  resolveChunkBudget,
  shouldChunkText,
} from './chunk-processor.js'
import type { LlmConfigLayer } from './llm-config.js'
import { readCtx } from './llm-config.js'
import { type GateInput, type GateSlot, type GateState, createLlmGate } from './llm-gate.js'
import { promptSourcesFromCtx, resolvePrompt } from './llm-prompts.js'

export interface TranslateInput {
  text: string
  sourceLang?: string
  targetLang: string
  /** Per-call model override (llm backend). */
  model?: string
}

export interface TranslateOutput {
  translatedText: string
  model?: string
  tokens?: number
}

/**
 * Legacy translate tool configuration (kept for backwards compatibility;
 * `translateText` itself now takes the wider {@link TranslateTextOptions}).
 */
export interface TranslateToolConfig {
  targetLang: string
  batchSize?: number
  chunkSize?: number
}

export interface TranslateTextOptions {
  /** Default target language when an input omits `targetLang`. */
  targetLang?: string
  /**
   * `router` (default): POST `/api/translate` on the MT router proxy.
   * `llm`: direct-to-provider via the LLM toolkit (prompts `translate.system` /
   * `translate.user`, provider from `resolveLlmConfig`).
   */
  backend?: 'router' | 'llm'
  /** Tool-level LLM config for the `llm` backend (provider/model/keys/...). */
  llm?: LlmConfigLayer
  /** Override the router proxy URL (default: ctx `routerUrl` / `MT_ROUTER_URL`). */
  routerUrl?: string
  /** Prompt template overrides (`translate.system` / `translate.user`). */
  prompts?: Record<string, string>
  /** How oversized text is handled. Default 'shrink' (the gate's fit slot). */
  chunkMode?: TranslateChunkMode
  /** Per-chunk output reserve. Default 2048. */
  outputReserve?: number
  /** Safety reserve tokens. Default 64. */
  reserve?: number
  /** Semantic split unit. Default 'paragraph'. */
  splitUnit?: SemanticUnit
  /** Chunk processing concurrency. Default 2. */
  chunkConcurrency?: number
}

export type TranslateChunkMode = 'shrink' | 'chunk' | 'auto'

// ---------------------------------------------------------------------------
// Shared implementation (also used by llm-translate.ts)
// ---------------------------------------------------------------------------

/** Map a translate input to the generic gate input (shared with `llmTranslate`). */
export function translateNormalize(targetLangDefault?: string) {
  return (i: TranslateInput): GateInput => {
    const targetLang = i.targetLang ?? targetLangDefault
    if (!targetLang) {
      throw new Error('translate: targetLang is required (input.targetLang or tool option)')
    }
    return {
      systemPromptName: 'translate.system',
      promptName: 'translate.user',
      vars: {
        text: i.text,
        targetLang,
        sourceLang: i.sourceLang ?? 'the source language',
        // the bundled translate.system template composes these optional blocks
        glossaryBlock: '',
        summaryBlock: '',
        extraRules: '',
      },
      model: i.model,
    }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Shared output shaping: trim the model/router answer into `TranslateOutput`. */
export function translateToOutput(state: GateState<TranslateInput>): TranslateOutput {
  const r = state.response
  if (!r) throw new Error('translate emit slot: state.response missing (did call run?)')
  return {
    // the bundled prompt asks for a trailing <terms> report; it is metadata, not translation
    translatedText: cleanTranslation(r.content),
    ...(r.model ? { model: r.model } : {}),
    ...(r.usage.totalTokens > 0 ? { tokens: r.usage.totalTokens } : {}),
  }
}

/**
 * Build the shared translate gate. `llmTranslate` uses it as-is; `translateText`
 * replaces the `call` slot with the router `/api/translate` backend by default.
 */
export function createTranslateGate(
  name: string,
  options: TranslateTextOptions = {},
  mdDescription?: string,
): ComposableTool<TranslateInput, TranslateOutput, GateSlot> {
  return createLlmGate<TranslateInput, TranslateOutput>({
    name,
    mdDescription:
      mdDescription ??
      'Translates text with swappable slots prepare/fit/call/parse/emit; prompts translate.system / translate.user.',
    llm: options.llm,
    prompts: options.prompts,
    normalize: translateNormalize(options.targetLang),
    toOutput: translateToOutput,
    metaFlags: { translated: true },
  })
}

// ---------------------------------------------------------------------------
// Router `/api/translate` call slot (legacy backend, default for translateText)
// ---------------------------------------------------------------------------

interface RouterTranslateResponse {
  translatedText?: string
  model?: string
  tokens?: number
}

async function routerTranslateSingle(
  input: TranslateInput,
  routerUrl: string,
  signal?: AbortSignal,
): Promise<RouterTranslateResponse> {
  const url = new URL('/api/translate', routerUrl)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      targetLang: input.targetLang,
      sourceLang: input.sourceLang,
    }),
    signal,
  })
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Translation failed: ${response.status} ${error}`)
  }
  return (await response.json()) as RouterTranslateResponse
}

/** `call` slot backend that POSTs to the router proxy `/api/translate` (legacy behaviour). */
export function routerTranslateCall(
  options: TranslateTextOptions = {},
): Tool<GateState, GateState> {
  return defineTool<GateState, GateState>({
    name: 'translate-text:call',
    version: '1.0.0',
    mdDescription: 'Calls the router proxy POST /api/translate endpoint.',
    async invoke(env: Exchange<GateState>, ctx: ToolContext): Promise<Exchange<GateState>> {
      const routerUrl = options.routerUrl ?? readCtx(ctx).routerUrl ?? 'http://localhost:7777'
      const states = env.items ?? [env.item]
      const out: GateState[] = []
      for (const state of states) {
        const input = state.input as TranslateInput
        const body = await routerTranslateSingle(input, routerUrl, undefined)
        out.push({
          ...state,
          response: {
            content: body.translatedText ?? '',
            model: body.model ?? '',
            usage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: num(body.tokens),
            },
          },
          usage: {
            ...state.usage,
            totalTokens: state.usage.totalTokens + num(body.tokens),
            calls: state.usage.calls + 1,
          },
        })
      }
      const next = withItem(env, out[0] as GateState)
      return env.items ? { ...next, items: out } : next
    },
  })
}

// ---------------------------------------------------------------------------
// Chunk budget for translate
// ---------------------------------------------------------------------------

function translateBudget(
  input: TranslateInput,
  options: TranslateTextOptions,
  env: Exchange<unknown>,
  ctx: ToolContext,
): ChunkBudget | null {
  const ps = promptSourcesFromCtx(ctx, { tool: options.prompts })
  let systemTokens = 0
  let userPrefixTokens = 0
  try {
    const systemText = resolvePrompt('translate.system', {}, ps.sources, ps.env)
    systemTokens = countTextTokens(systemText)
  } catch {
    systemTokens = TRANSLATE_SYSTEM_FALLBACK_TOKENS
  }
  try {
    const userPrefix = resolvePrompt(
      'translate.user',
      {
        text: '',
        sourceLang: input.sourceLang ?? 'the source language',
        targetLang: input.targetLang,
      },
      ps.sources,
      ps.env,
    )
    userPrefixTokens = countTextTokens(userPrefix)
  } catch {
    userPrefixTokens = TRANSLATE_PREFIX_FALLBACK_TOKENS
  }
  const overhead = systemTokens + userPrefixTokens + PROMPT_OVERHEAD_SLACK_TOKENS
  return resolveChunkBudget({
    ctx,
    input: {
      model: input.model,
      outputReserve:
        options.outputReserve ??
        resolveTunedNum('DEFAULT_OUTPUT_RESERVE', DEFAULT_OUTPUT_RESERVE, env, ctx),
      overhead,
      reserve: options.reserve,
    },
    llmConfig: options.llm,
  })
}

interface GateUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  calls: number
  cached: number
  costUsd?: number
}

function zeroUsage(): GateUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, cached: 0 }
}

function addToUsage(target: GateUsage, source: Partial<GateUsage>): void {
  target.promptTokens += source.promptTokens ?? 0
  target.completionTokens += source.completionTokens ?? 0
  target.totalTokens += source.totalTokens ?? 0
  target.calls += source.calls ?? 0
  target.cached += source.cached ?? 0
  if (source.costUsd !== undefined) {
    target.costUsd = (target.costUsd ?? 0) + source.costUsd
  }
}

// ---------------------------------------------------------------------------
// Chunked translate wrapper
// ---------------------------------------------------------------------------

export type TranslateToolLike = Tool<TranslateInput, TranslateOutput> & {
  slots: ComposableTool<TranslateInput, TranslateOutput, GateSlot>['slots']
  with: ComposableTool<TranslateInput, TranslateOutput, GateSlot>['with']
}

export function createChunkedTranslateText(
  gate: ComposableTool<TranslateInput, TranslateOutput, GateSlot>,
  options: TranslateTextOptions,
): TranslateToolLike {
  // Only constructed for 'chunk' | 'auto'; 'shrink' (the default) returns the bare gate.
  const mode: 'chunk' | 'auto' = options.chunkMode === 'auto' ? 'auto' : 'chunk'

  const wrapper: TranslateToolLike = defineTool<TranslateInput, TranslateOutput>({
    name: gate.name,
    version: gate.version,
    mdDescription: `${gate.mdDescription ?? ''} Chunk mode: oversized text is split into budget-sized chunks, translated, and merged.`,
    async invoke(env, ctx) {
      const inputs = env.items ?? [env.item]
      const outputs: TranslateOutput[] = []
      const records: Array<{ chunks: number; limit: number; inputBudget: number; model: string }> =
        []
      const allUsage = zeroUsage()

      for (const input of inputs) {
        const budget = translateBudget(input, options, env, ctx)
        if (!budget || (mode === 'auto' && !shouldChunkText(input.text, budget))) {
          const single = await gate.invoke(withItem(env, input), ctx)
          outputs.push(single.item)
          const usage = getVariable(single, 'llmUsage')
          if (isUsage(usage)) addToUsage(allUsage, usage)
          continue
        }

        const chunks = adaptiveSemanticChunks(input.text, budget, {
          unit: options.splitUnit ?? 'paragraph',
          count: countTextTokens,
        })

        let chunkTokens = 0
        let chunkModel = ''
        const mergedText = await processChunks({
          chunks,
          process: async (chunk) => {
            const chunkInput: TranslateInput = { ...input, text: chunk }
            const out = await gate.invoke(withItem(env, chunkInput), ctx)
            const usage = getVariable(out, 'llmUsage')
            if (isUsage(usage)) addToUsage(allUsage, usage)
            chunkTokens += out.item.tokens ?? 0
            if (!chunkModel && out.item.model) chunkModel = out.item.model
            return out.item.translatedText
          },
          merge: (parts) => parts.join('\n\n'),
          concurrency:
            options.chunkConcurrency ??
            resolveTunedNum('DEFAULT_CHUNK_CONCURRENCY', DEFAULT_CHUNK_CONCURRENCY, env, ctx),
        })

        outputs.push({
          translatedText: mergedText,
          model: chunkModel || budget.model,
          ...(chunkTokens > 0 ? { tokens: chunkTokens } : {}),
        })
        records.push({
          chunks: chunks.length,
          limit: budget.limit,
          inputBudget: budget.inputBudget,
          model: budget.model,
        })
      }

      let next = withItem(env, (env.items ? outputs : outputs[0]) as TranslateOutput)
      if (records.length > 0) {
        next = setVariable(next, 'translateChunks', env.items ? records : records[0])
      }
      if (allUsage.calls > 0) {
        next = setVariable(next, 'llmUsage', allUsage)
      }
      return env.items ? { ...next, items: outputs } : next
    },
  }) as TranslateToolLike

  wrapper.slots = gate.slots
  wrapper.with = (overrides) => createChunkedTranslateText(gate.with(overrides), options)

  return wrapper
}

function isUsage(value: unknown): value is Partial<GateUsage> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'totalTokens' in value &&
    typeof (value as Partial<GateUsage>).totalTokens === 'number'
  )
}

// ---------------------------------------------------------------------------
// translateText
// ---------------------------------------------------------------------------

/**
 * Composable translation tool (slots `prepare, fit, call, parse, emit`).
 * Default `call` backend is the router proxy `/api/translate`; pass
 * `{ backend: 'llm' }` (or swap the `call` slot) to go direct-to-provider
 * through the LLM toolkit. Swap parts with `.with({ call: ... })` etc.
 */
export function createTranslateText(options: TranslateTextOptions = {}): TranslateToolLike {
  let gate = createTranslateGate(
    'translate-text',
    options,
    'Translates text via OpenRouter proxy. Supports source/target language specification. ' +
      'Composable: swap the call slot (router `/api/translate` default) or pick backend `llm`.',
  )
  if (options.backend !== 'llm') {
    gate = gate.with({ call: routerTranslateCall(options) })
  }

  const result =
    options.chunkMode && options.chunkMode !== 'shrink'
      ? createChunkedTranslateText(gate, options)
      : (gate as TranslateToolLike)
  return annotate(
    result,
    tool('TL026', {
      name: 'translate-text',
      description: 'Translates text through the router or LLM backend.',
      refs: ['UC059', 'UC060', 'UC061'],
      meta: { alsoCovers: ['TL051'] },
    }),
    useCase('UC060'),
  )
}

export const translateText = createTranslateText()
