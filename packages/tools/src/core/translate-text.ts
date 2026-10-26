import { defineTool, withItem } from '@mt/core'
import type { ComposableTool, Exchange, Tool, ToolContext } from '@mt/core'
import { cleanTranslation } from '../normalization/translation-prompt.js'
import type { LlmConfigLayer } from './llm-config.js'
import { readCtx } from './llm-config.js'
import { type GateInput, type GateSlot, type GateState, createLlmGate } from './llm-gate.js'

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
}

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
// translateText
// ---------------------------------------------------------------------------

/**
 * Composable translation tool (slots `prepare, fit, call, parse, emit`).
 * Default `call` backend is the router proxy `/api/translate`; pass
 * `{ backend: 'llm' }` (or swap the `call` slot) to go direct-to-provider
 * through the LLM toolkit. Swap parts with `.with({ call: ... })` etc.
 */
export function createTranslateText(
  options: TranslateTextOptions = {},
): ComposableTool<TranslateInput, TranslateOutput, GateSlot> {
  const gate = createTranslateGate(
    'translate-text',
    options,
    'Translates text via OpenRouter proxy. Supports source/target language specification. ' +
      'Composable: swap the call slot (router `/api/translate` default) or pick backend `llm`.',
  )
  return options.backend === 'llm' ? gate : gate.with({ call: routerTranslateCall(options) })
}

export const translateText = createTranslateText()
