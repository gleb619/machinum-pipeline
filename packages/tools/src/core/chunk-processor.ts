import { mapConcurrent, setVariable, withItem } from '@mt/core'
import type { Exchange, Tool, ToolContext } from '@mt/core'
import { countTextTokens } from '../normalization/token-counter.js'
import { type LlmConfigLayer, readCtx, resolveLlmConfigFromCtx } from './llm-config.js'
import { modelContextLimit, resolveContextConfig } from './llm-context.js'

// ---------------------------------------------------------------------------
// Budget
//
// Token counts use the shared tiktoken-based `countTextTokens`; real providers tokenize
// differently, so budgets are approximations - `reserve` (default 64) absorbs the drift.
// Boundary with `normalization/token-splitter.ts`: that file is a pipeline Tool that emits
// chunks; this module is a budget-aware library used inside LLM tools (no Tool I/O).
// ---------------------------------------------------------------------------

/** Default per-call output reserve (tokens) when a tool does not state one. */
export const DEFAULT_OUTPUT_RESERVE = 2048

/** Prompt overhead = token cost of the prompt text that surrounds the chunk, plus framing slack. */
export function estimateOverhead(...promptParts: readonly string[]): number {
  return promptParts.reduce((sum, part) => sum + countTextTokens(part), 0) + 8
}

export interface ChunkBudgetInput {
  /** Explicit context limit; wins over model table and context config. */
  contextLimit?: number
  /** Max output tokens to reserve per chunk call. */
  outputReserve?: number
  /** Reasoning/thinking token reserve. */
  thinkReserve?: number
  /** Fixed prompt overhead tokens. If omitted, caller should compute and pass. */
  overhead?: number
  /** Extra safety reserve. Default 64. */
  reserve?: number
  /** Model id used for auto context lookup. */
  model?: string
}

export interface ChunkBudget {
  /** Resolved model context limit. */
  limit: number
  outputReserve: number
  thinkReserve: number
  overhead: number
  reserve: number
  /** Max input tokens allowed inside a single chunk call. */
  inputBudget: number
  model: string
}

/** Reasoning-family models need headroom for thinking tokens. */
export function estimateReasoningReserve(model: string | undefined): number {
  if (!model) return 0
  const m = model.toLowerCase()
  const id = m.split('/').pop() ?? m
  if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 8000
  if (m.includes('deepseek-reasoner') || m.includes('deepseek-r1')) return 4000
  if (m.includes('qwq')) return 4000
  if (m.includes('claude-4')) return 4000
  return 0
}

/**
 * Resolve a per-chunk token budget from (in precedence order):
 * explicit input options, the LLM config / model context table, mt.json context settings, env.
 * Returns null when no context limit can be determined.
 */
export function resolveChunkBudget(args: {
  ctx?: ToolContext
  input?: ChunkBudgetInput
  llmConfig?: LlmConfigLayer
}): ChunkBudget | null {
  const model =
    args.input?.model ??
    (args.ctx
      ? resolveLlmConfigFromCtx(args.ctx, { input: args.llmConfig, tool: undefined, meta: {} })
          .model
      : undefined) ??
    'openai/gpt-4o-mini'

  let contextLimit: number | undefined
  if (args.input?.contextLimit !== undefined) {
    contextLimit = args.input.contextLimit
  } else if (args.ctx) {
    const view = readCtx(args.ctx)
    const resolved = resolveContextConfig({
      settings: view.settings,
      env: view.env,
      modelLimit: modelContextLimit(model),
    })
    contextLimit = resolved.contextLimit ?? resolved.limit ?? modelContextLimit(model)
  }
  contextLimit ??= modelContextLimit(model)

  if (contextLimit === undefined) return null

  const outputReserve = args.input?.outputReserve ?? 0
  const thinkReserve = args.input?.thinkReserve ?? estimateReasoningReserve(model)
  const reserve = args.input?.reserve ?? 64
  const overhead = args.input?.overhead ?? 0
  const inputBudget = Math.max(1, contextLimit - outputReserve - thinkReserve - overhead - reserve)

  return { limit: contextLimit, outputReserve, thinkReserve, overhead, reserve, inputBudget, model }
}

/** True when the text alone exceeds the per-chunk input budget. */
export function shouldChunkText(
  text: string,
  budget: ChunkBudget,
  count: (text: string) => number = countTextTokens,
): boolean {
  return count(text) > budget.inputBudget
}

// ---------------------------------------------------------------------------
// Semantic splitting
// ---------------------------------------------------------------------------

export type SemanticUnit = 'paragraph' | 'sentence' | 'line' | 'word'

export interface SemanticChunkOptions {
  /** Preferred unit. Default 'paragraph'. */
  unit?: SemanticUnit
  /** Token counter. Default tiktoken via countTextTokens. */
  count?: (text: string) => number
  /** Character overlap copied from the next chunk to the previous one. Default 0. */
  overlapChars?: number
}

const SENTENCE_END = /[.!?](?:\s|$)/g

function splitUnits(text: string, unit: SemanticUnit): string[] {
  switch (unit) {
    case 'paragraph':
      return text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    case 'sentence': {
      const sentences: string[] = []
      let cursor = 0
      for (const match of text.matchAll(SENTENCE_END)) {
        const end = (match.index ?? 0) + match[0].length
        sentences.push(text.slice(cursor, end).trim())
        cursor = end
      }
      if (cursor < text.length) {
        sentences.push(text.slice(cursor).trim())
      }
      return sentences.filter((s) => s.length > 0)
    }
    case 'line':
      return text.split(/\r?\n/).filter((l) => l.length > 0)
    case 'word':
      return text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0)
  }
}

function joinerFor(unit: SemanticUnit): string {
  switch (unit) {
    case 'paragraph':
      return '\n\n'
    case 'sentence':
    case 'word':
      return ' '
    case 'line':
      return '\n'
  }
}

function nextUnit(unit: SemanticUnit): SemanticUnit | undefined {
  switch (unit) {
    case 'paragraph':
      return 'sentence'
    case 'sentence':
      return 'line'
    case 'line':
      return 'word'
    case 'word':
      return undefined
  }
}

function chunkUnitsGreedy(
  units: string[],
  budget: ChunkBudget,
  count: (text: string) => number,
  join: string,
): string[] {
  const chunks: string[] = []
  let current: string[] = []

  for (const unit of units) {
    const probe = current.length === 0 ? unit : current.join(join) + join + unit
    if (current.length > 0 && count(probe) > budget.inputBudget) {
      chunks.push(current.join(join))
      current = [unit]
    } else {
      current.push(unit)
    }
  }
  if (current.length > 0) {
    chunks.push(current.join(join))
  }
  return chunks.length > 0 ? chunks : [units.join(join)]
}

function splitByChars(
  text: string,
  budget: ChunkBudget,
  count: (text: string) => number,
): string[] {
  if (count(text) <= budget.inputBudget) return [text]
  const chars = Array.from(text)
  const chunks: string[] = []
  let current = ''
  for (const ch of chars) {
    if (current && count(current + ch) > budget.inputBudget) {
      chunks.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

/**
 * Split text into semantically coherent chunks so that each chunk fits the input budget.
 * Falls back from paragraphs -> sentences -> lines -> words -> characters.
 */
export function adaptiveSemanticChunks(
  text: string,
  budget: ChunkBudget,
  options?: SemanticChunkOptions,
): string[] {
  const count = options?.count ?? countTextTokens
  const unit = options?.unit ?? 'paragraph'
  const overlapChars = Math.max(0, Math.floor(options?.overlapChars ?? 0))

  if (count(text) <= budget.inputBudget) return [text]

  const units = splitUnits(text, unit)
  const join = joinerFor(unit)
  const chunks = chunkUnitsGreedy(units, budget, count, join)

  // Recurse on any chunk that still exceeds the budget, moving to a finer unit.
  const finer = nextUnit(unit)
  const result: string[] = []
  for (const chunk of chunks) {
    if (count(chunk) > budget.inputBudget && finer !== undefined) {
      result.push(...adaptiveSemanticChunks(chunk, budget, { ...options, unit: finer }))
    } else if (count(chunk) > budget.inputBudget) {
      result.push(...splitByChars(chunk, budget, count))
    } else {
      result.push(chunk)
    }
  }

  if (overlapChars > 0 && result.length > 1) {
    for (let i = 0; i < result.length - 1; i++) {
      const next = result[i + 1]
      if (next !== undefined) {
        const copy = next.slice(0, overlapChars)
        result[i] = `${result[i] ?? ''}${copy}`
      }
    }
  }

  return result.length > 0 ? result : [text]
}

// ---------------------------------------------------------------------------
// Grouping pre-existing units under a budget
// ---------------------------------------------------------------------------

export interface ChunkGroupOptions<T> {
  items: T[]
  budget: ChunkBudget
  /** Tokens for a group string built by the render function. */
  weigh: (group: T[]) => number
  /** Build the chunk payload from a group. */
  render: (group: T[]) => string
}

/**
 * Group a list of items into chunk payloads so each payload fits the budget.
 * Greedy: adds items until the next item would exceed the budget, then starts a new chunk.
 */
export function groupItemsToBudget<T>(options: ChunkGroupOptions<T>): string[] {
  const { items, budget, weigh, render } = options
  const groups: T[][] = []
  let current: T[] = []

  for (const item of items) {
    const probe = [...current, item]
    if (current.length > 0 && weigh(probe) > budget.inputBudget) {
      groups.push(current)
      current = [item]
    } else {
      current = probe
    }
  }
  if (current.length > 0) groups.push(current)

  return groups.map(render)
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ChunkProcessOptions<O> {
  chunks: string[]
  process: (chunk: string, index: number) => Promise<O>
  merge: (outputs: readonly O[]) => O
  concurrency?: number
}

async function* yieldArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

/**
 * Process every chunk and merge the results. If only one chunk, invokes `process` directly.
 */
export async function processChunks<O>(options: ChunkProcessOptions<O>): Promise<O> {
  const { chunks, process, merge, concurrency = 1 } = options
  if (chunks.length === 0) return merge([])
  if (chunks.length === 1) return process(chunks[0] as string, 0)

  const outputs: O[] = []
  let index = 0
  for await (const out of mapConcurrent(
    yieldArray(chunks),
    Math.max(1, concurrency),
    async (chunk) => {
      const i = index++
      return process(chunk, i)
    },
  )) {
    outputs.push(out)
  }
  return merge(outputs)
}

export interface TextChunkOptions<O> {
  text: string
  budget: ChunkBudget
  process: (chunk: string, index: number) => Promise<O>
  merge: (outputs: readonly O[]) => O
  split?: SemanticUnit | ((text: string, budget: ChunkBudget) => string[])
  count?: (text: string) => number
  concurrency?: number
}

/**
 * High-level helper: split text to fit the budget, process each chunk, merge.
 * If the whole text already fits, calls `process` once.
 */
export async function processTextInChunks<O>(options: TextChunkOptions<O>): Promise<O> {
  const count = options.count ?? countTextTokens
  const unit: SemanticUnit =
    (typeof options.split === 'function' ? undefined : options.split) ?? 'paragraph'
  const splitFn =
    typeof options.split === 'function'
      ? options.split
      : (text: string, budget: ChunkBudget) => adaptiveSemanticChunks(text, budget, { unit, count })

  const chunks = splitFn(options.text, options.budget)
  return processChunks({
    chunks,
    process: options.process,
    merge: options.merge,
    concurrency: options.concurrency,
  })
}

/** Budget + split metadata recorded as a variable. */
export interface ChunkProcessorRecord {
  mode: string
  limit: number
  inputBudget: number
  model: string
  chunks: number
  unit: SemanticUnit
}

export const VAR_CHUNK_PROCESSOR = 'chunkProcessor'

// ---------------------------------------------------------------------------
// Decorator: add chunk mode to any text-in/text-out tool
// ---------------------------------------------------------------------------

export interface ChunkedToolOptions {
  budget: ChunkBudget
  mode?: 'chunk' | 'auto'
  split?: SemanticUnit | ((text: string, budget: ChunkBudget) => string[])
  count?: (text: string) => number
  concurrency?: number
  /** Record chunk metadata. Default true. */
  record?: boolean
}

/**
 * Wrap a text-in/text-out tool so that oversized input is split into chunks,
 * each chunk is processed by the inner tool, and the outputs are merged.
 *
 * The wrapper is a plain Tool; the inner tool's variables are lost unless the
 * caller aggregates them. For gate-style tools, prefer using the gate inside
 * `process` and aggregating `llmUsage` manually.
 */
export function withTextChunks<I extends { text: string }, O extends { text: string }>(
  tool: Tool<I, O>,
  options: ChunkedToolOptions,
): Tool<I, O> {
  const count = options.count ?? countTextTokens
  const unit: SemanticUnit =
    (typeof options.split === 'function' ? undefined : options.split) ?? 'paragraph'
  const splitFn =
    typeof options.split === 'function'
      ? options.split
      : (text: string, budget: ChunkBudget) => adaptiveSemanticChunks(text, budget, { unit, count })

  return {
    ...tool,
    async invoke(env, ctx) {
      const inputs = env.items ?? [env.item]
      const outputs: O[] = []
      const records: ChunkProcessorRecord[] = []
      for (const input of inputs) {
        const textTokens = count(input.text)
        if (options.mode === 'auto' && textTokens <= options.budget.inputBudget) {
          const single = await tool.invoke(withItem(env, input), ctx)
          outputs.push(single.item)
          continue
        }
        const chunks = splitFn(input.text, options.budget)
        const merged = await processChunks({
          chunks,
          process: async (chunk) => {
            const out = await tool.invoke(withItem(env, { ...input, text: chunk } as I), ctx)
            return out.item
          },
          merge: (outs) => {
            const mergedText = outs.map((o) => o.text).join('\n\n')
            return { ...outs[0], text: mergedText } as O
          },
          concurrency: options.concurrency,
        })
        outputs.push(merged)
        records.push({
          mode: options.mode ?? 'chunk',
          limit: options.budget.limit,
          inputBudget: options.budget.inputBudget,
          model: options.budget.model,
          chunks: chunks.length,
          unit,
        })
      }
      let next = withItem(env, (env.items ? outputs : outputs[0]) as O)
      if (options.record !== false && records.length > 0) {
        next = setVariable(next, VAR_CHUNK_PROCESSOR, env.items ? records : records[0])
      }
      return env.items ? { ...next, items: outputs } : next
    },
  }
}
