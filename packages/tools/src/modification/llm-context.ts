import { defineTool } from '@mt/core'
import type { Envelope, Tool, ToolContext } from '@mt/core'
import { countTextTokens } from '../verification/token-counter.js'
import { type LlmClient, type LlmMessage, createLlmClient } from './llm-client.js'
import { type LlmConfigLayer, readCtx, resolveLlmConfigFromCtx } from './llm-config.js'
import { LlmContextLengthError } from './llm-errors.js'
import { type PromptSources, promptSourcesFromCtx, resolvePrompt } from './llm-prompts.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShrinkBudget {
  /** Max tokens allowed for the input messages. */
  limit: number
}

export interface ShrinkHelpers {
  countText(text: string): number
  /** Tokens for a whole message list (content + small per-message overhead). */
  count(messages: LlmMessage[]): number
  /** True for messages strategies must not remove/alter (system, last user by default). */
  isProtected(message: LlmMessage, index: number, all: LlmMessage[]): boolean
  /** Client for LLM-backed strategies (lazy; may be absent). */
  llm?: LlmClient
  model?: string
  /** Render a named prompt through the prompt override chain. */
  prompt(name: string, vars: Record<string, unknown>): string
  /** Record a note (e.g. fallback) in `meta.contextWindow.applied`. */
  report(note: string): void
  signal?: AbortSignal
}

export interface ShrinkStrategy {
  name: string
  apply(
    messages: LlmMessage[],
    budget: ShrinkBudget,
    helpers: ShrinkHelpers,
  ): LlmMessage[] | Promise<LlmMessage[]>
}

export type StrategySpec = string | ShrinkStrategy | [string, Record<string, unknown>]

export interface ContextWindowRecord {
  before: number
  after: number
  budget: number | null
  fits: boolean
  applied: Array<{ name: string; before: number; after: number; note?: string }>
}

const MESSAGE_OVERHEAD = 4

export const defaultCountTokens = (text: string): number => countTextTokens(text)

function makeHelpers(
  countTokens: (text: string) => number,
  base: Pick<ShrinkHelpers, 'llm' | 'model' | 'prompt' | 'report' | 'signal'>,
  preserveSystem: boolean,
  preserveLastUser: boolean,
): ShrinkHelpers {
  return {
    ...base,
    countText: countTokens,
    count: (msgs) => msgs.reduce((n, m) => n + countTokens(m.content) + MESSAGE_OVERHEAD, 0),
    isProtected: (m, i, all) => {
      if (preserveSystem && m.role === 'system') return true
      if (preserveLastUser && m.role === 'user') {
        for (let j = all.length - 1; j >= 0; j--) {
          if (all[j]?.role === 'user') return j === i
        }
      }
      return false
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in strategies
// ---------------------------------------------------------------------------

const MARKER = '[...truncated...]'

type CutMode = 'tail' | 'head' | 'lines' | 'headtail'

function unmark(text: string): string {
  return text.includes(MARKER)
    ? text
        .split('\n')
        .filter((l) => l !== MARKER)
        .join('\n')
    : text
}

function cutText(raw: string, keep: number, mode: CutMode): string {
  const text = unmark(raw)
  if (text.length <= keep) return raw
  if (mode === 'tail') return `${text.slice(0, keep)}\n${MARKER}`
  if (mode === 'head') return `${MARKER}\n${text.slice(text.length - keep)}`
  if (mode === 'headtail') {
    const half = Math.max(1, Math.floor(keep / 2))
    return `${text.slice(0, half)}\n${MARKER}\n${text.slice(text.length - half)}`
  }
  const lines = text.split('\n')
  if (lines.length <= 2) return cutText(text, keep, 'tail')
  const half = Math.max(1, Math.floor(keep / 2))
  const head: string[] = []
  const tail: string[] = []
  let used = 0
  for (const l of lines) {
    if (used + l.length > half && head.length > 0) break
    head.push(l)
    used += l.length + 1
  }
  used = 0
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i] as string
    if (used + l.length > half && tail.length > 0) break
    tail.unshift(l)
    used += l.length + 1
  }
  if (head.length + tail.length >= lines.length) return cutText(text, keep, 'tail')
  return [...head, MARKER, ...tail].join('\n')
}

export interface TruncateOptions {
  /** Never cut a message below this many characters. Default 200. */
  minChars?: number
}

function truncateStrategy(name: string, mode: CutMode, opts: TruncateOptions = {}): ShrinkStrategy {
  const minChars = opts.minChars ?? 200
  return {
    name,
    apply(messages, budget, h) {
      let cur = messages
      for (let iter = 0; iter < 100; iter++) {
        const total = h.count(cur)
        if (total <= budget.limit) break
        const over = total - budget.limit
        const cands = cur
          .map((m, i) => ({ m, i, t: h.countText(m.content) }))
          .filter(
            ({ m, i }) => !h.isProtected(m, i, cur) && m.content.length > minChars + MARKER.length,
          )
          .sort((a, b) => b.t - a.t)
        const top = cands[0]
        if (!top) break
        const keepTokens = Math.max(1, top.t - over)
        let keepChars = Math.floor((top.m.content.length * keepTokens) / Math.max(1, top.t))
        // leave room for the marker line so every pass makes progress
        keepChars = Math.max(minChars, keepChars - MARKER.length - 1)
        const next = cutText(top.m.content, keepChars, mode)
        if (next.length >= top.m.content.length) break
        cur = cur.map((m, i) => (i === top.i ? { ...m, content: next } : m))
      }
      return cur
    },
  }
}

export const truncateTail = (o?: TruncateOptions): ShrinkStrategy =>
  truncateStrategy('truncateTail', 'tail', o)
export const truncateHead = (o?: TruncateOptions): ShrinkStrategy =>
  truncateStrategy('truncateHead', 'head', o)
/** Drops whole lines from the middle of the largest messages, keeping head and tail lines. */
export const truncateLines = (o?: TruncateOptions): ShrinkStrategy =>
  truncateStrategy('truncateLines', 'lines', o)

export interface DropOldestOptions {
  /** Keep at least this many most-recent messages (besides protected ones). Default 0. */
  keepLast?: number
}

/** Drop the oldest unprotected messages until it fits. */
export function dropOldest(opts: DropOldestOptions = {}): ShrinkStrategy {
  const keepLast = opts.keepLast ?? 0
  return {
    name: 'dropOldest',
    apply(messages, budget, h) {
      let cur = messages
      while (h.count(cur) > budget.limit) {
        const idx = cur.findIndex((m, i) => i < cur.length - keepLast && !h.isProtected(m, i, cur))
        if (idx < 0) break
        cur = cur.filter((_, i) => i !== idx)
      }
      return cur
    },
  }
}

export interface DropMiddleOptions {
  /** Unprotected messages kept at the start. Default 1. */
  keepHead?: number
  /** Unprotected messages kept at the end. Default 2. */
  keepTail?: number
}

/** Drop messages from the middle of the conversation outward; keep opening and recent turns. */
export function dropMiddle(opts: DropMiddleOptions = {}): ShrinkStrategy {
  const keepHead = opts.keepHead ?? 1
  const keepTail = opts.keepTail ?? 2
  return {
    name: 'dropMiddle',
    apply(messages, budget, h) {
      let cur = messages
      while (h.count(cur) > budget.limit) {
        const un = cur.map((_, i) => i).filter((i) => !h.isProtected(cur[i] as LlmMessage, i, cur))
        const removable = un.slice(keepHead, Math.max(keepHead, un.length - keepTail))
        if (removable.length === 0) break
        const victim = removable[Math.floor(removable.length / 2)] as number
        cur = cur.filter((_, i) => i !== victim)
      }
      return cur
    },
  }
}

export interface SlidingWindowOptions {
  /** Max unprotected messages kept (shrinks further if still too big). Default 10. */
  size?: number
}

/** Keep protected messages + the last `size` others; shrink the window until it fits. */
export function slidingWindow(opts: SlidingWindowOptions = {}): ShrinkStrategy {
  const size = opts.size ?? 10
  return {
    name: 'slidingWindow',
    apply(messages, budget, h) {
      const un = messages
        .map((_, i) => i)
        .filter((i) => !h.isProtected(messages[i] as LlmMessage, i, messages))
      let result = messages
      for (let s = Math.min(size, un.length); s >= 0; s--) {
        const keep = new Set(un.slice(un.length - s))
        result = messages.filter((m, i) => keep.has(i) || h.isProtected(m, i, messages))
        if (h.count(result) <= budget.limit) return result
      }
      return result
    },
  }
}

export interface SummarizeOptions {
  /** Most recent unprotected messages kept verbatim. Default 4. */
  keepLast?: number
  /** Target summary length passed to the prompt. Default 200. */
  maxWords?: number
  /** Prompt name (override via the prompt chain). Default `context.summarize`. */
  promptName?: string
}

/**
 * Summarize the oldest unprotected messages into ONE message via the LlmClient.
 * Falls back to `dropOldest` when there is no client or the call fails.
 */
export function summarize(opts: SummarizeOptions = {}): ShrinkStrategy {
  const keepLast = opts.keepLast ?? 4
  const maxWords = opts.maxWords ?? 200
  const promptName = opts.promptName ?? 'context.summarize'
  return {
    name: 'summarize',
    async apply(messages, budget, h) {
      const un = messages
        .map((_, i) => i)
        .filter((i) => !h.isProtected(messages[i] as LlmMessage, i, messages))
      const older = un.slice(0, Math.max(0, un.length - keepLast))
      if (older.length === 0) return messages
      const fallback = () => dropOldest({ keepLast }).apply(messages, budget, h)
      if (!h.llm || !h.model) {
        h.report('fallback:no-llm')
        return fallback()
      }
      try {
        let transcript = older
          .map((i) => `${(messages[i] as LlmMessage).role}: ${(messages[i] as LlmMessage).content}`)
          .join('\n')
        const maxTranscript = Math.max(200, budget.limit - 500)
        const t = h.countText(transcript)
        if (t > maxTranscript) {
          transcript = cutText(
            transcript,
            Math.floor((transcript.length * maxTranscript) / t),
            'tail',
          )
        }
        const res = await h.llm.chatCompletion({
          model: h.model,
          temperature: 0,
          messages: [{ role: 'user', content: h.prompt(promptName, { transcript, maxWords }) }],
          signal: h.signal,
        })
        const summary = res.content.trim()
        if (!summary) throw new Error('empty summary')
        const first = older[0] as number
        const drop = new Set(older)
        const out: LlmMessage[] = []
        messages.forEach((m, i) => {
          if (i === first) {
            out.push({ role: 'user', content: `[Summary of earlier conversation]\n${summary}` })
          }
          if (!drop.has(i)) out.push(m)
        })
        return out
      } catch (err) {
        h.report(`fallback:${err instanceof Error ? err.message : 'error'}`)
        return fallback()
      }
    },
  }
}

export type StrategyFactory = (options?: Record<string, unknown>) => ShrinkStrategy

/** Name -> factory. Extend with `registerShrinkStrategy` to use custom names in config/env. */
export const shrinkStrategies = new Map<string, StrategyFactory>([
  ['truncateLines', (o) => truncateLines(o)],
  ['truncateTail', (o) => truncateTail(o)],
  ['truncateHead', (o) => truncateHead(o)],
  ['dropOldest', (o) => dropOldest(o)],
  ['dropMiddle', (o) => dropMiddle(o)],
  ['slidingWindow', (o) => slidingWindow(o)],
  ['summarize', (o) => summarize(o)],
])

export function registerShrinkStrategy(name: string, factory: StrategyFactory): void {
  shrinkStrategies.set(name, factory)
}

export function resolveStrategy(spec: StrategySpec): ShrinkStrategy {
  if (typeof spec === 'object' && !Array.isArray(spec)) return spec
  const [name, options] = Array.isArray(spec) ? spec : [spec, undefined]
  const factory = shrinkStrategies.get(name)
  if (!factory) {
    throw new Error(
      `Unknown context strategy '${name}'. Known: ${[...shrinkStrategies.keys()].join(', ')}`,
    )
  }
  return factory(options)
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** What to do when the last user message alone exceeds the remaining budget. */
export type LastMessageStrategy = 'off' | 'truncate' | 'summarize' | 'error'

export interface FitOptions {
  /** Token budget for input messages; undefined/null = no-op. */
  limit?: number | null
  strategies?: StrategySpec[]
  countTokens?: (text: string) => number
  preserveSystem?: boolean
  preserveLastUser?: boolean
  llm?: LlmClient
  model?: string
  prompt?: (name: string, vars: Record<string, unknown>) => string
  signal?: AbortSignal
  /** Oversize last user message handling. Default 'off' (report fits=false). */
  lastMessage?: LastMessageStrategy
  /** Words budget passed to the summarize prompt. Default 200. */
  lastMessageMaxWords?: number
}

export const DEFAULT_STRATEGIES: StrategySpec[] = ['dropOldest', 'truncateLines']

/** Apply strategies in order until the messages fit. Returns new messages + a record. */
export async function fitMessages(
  messages: LlmMessage[],
  options: FitOptions = {},
): Promise<{ messages: LlmMessage[]; record: ContextWindowRecord }> {
  const countTokens = options.countTokens ?? defaultCountTokens
  const notes: string[] = []
  const h = makeHelpers(
    countTokens,
    {
      llm: options.llm,
      model: options.model,
      prompt: options.prompt ?? ((name, vars) => resolvePrompt(name, vars)),
      report: (n) => notes.push(n),
      signal: options.signal,
    },
    options.preserveSystem ?? true,
    options.preserveLastUser ?? true,
  )
  const limit = options.limit ?? null
  // No budget: nothing is measured (before/after stay 0, budget null) and no tokenizer is touched.
  if (limit === null) {
    return { messages, record: { before: 0, after: 0, budget: null, fits: true, applied: [] } }
  }
  const before = h.count(messages)
  const record: ContextWindowRecord = {
    before,
    after: before,
    budget: limit,
    fits: true,
    applied: [],
  }

  let cur = messages
  const strategies = (options.strategies ?? DEFAULT_STRATEGIES).map(resolveStrategy)
  for (const s of strategies) {
    const pre = h.count(cur)
    if (pre <= limit) break
    notes.length = 0
    const next = await s.apply(cur, { limit }, h)
    const post = h.count(next)
    record.applied.push({
      name: s.name,
      before: pre,
      after: post,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    })
    cur = next
  }

  // Oversize LAST user message: strategies above never touch it (protected), so
  // handle it explicitly per `lastMessage`. The system message is never dropped.
  const lastMessage = options.lastMessage ?? 'off'
  if (lastMessage !== 'off' && h.count(cur) > limit) {
    let lastIdx = -1
    for (let i = cur.length - 1; i >= 0; i--) {
      if (cur[i]?.role === 'user') {
        lastIdx = i
        break
      }
    }
    if (lastIdx >= 0) {
      const rest = h.count(cur.filter((_, i) => i !== lastIdx))
      if (lastMessage === 'error') {
        throw new LlmContextLengthError(
          rest >= limit
            ? `Last user message does not fit the context budget: ${rest} tokens of other messages already exceed the ${limit} token budget`
            : `Last user message alone exceeds the remaining ${Math.max(0, limit - rest)} tokens of the ${limit} token budget`,
        )
      }
      if (rest < limit) {
        const before = h.count(cur)
        const original = cur[lastIdx] as LlmMessage
        let appliedName = 'truncateLastMessage'
        let content: string | undefined
        if (lastMessage === 'summarize') {
          content = await summarizeLastMessage(original.content, limit - rest, h, options)
          if (content !== undefined) appliedName = 'summarizeLastMessage'
        }
        if (content === undefined) {
          content = truncateLastMessage(original.content, limit - rest, (t) => h.countText(t))
        }
        cur = cur.map((m, i) => (i === lastIdx ? { ...m, content } : m))
        record.applied.push({ name: appliedName, before, after: h.count(cur) })
      }
      // else: even without the last message there is no room; fits stays false.
    }
  }

  record.after = h.count(cur)
  record.fits = record.after <= limit
  return { messages: cur, record }
}

/** Shrink one message to roughly `budget` tokens, keeping head and tail with a marker. */
function truncateLastMessage(
  text: string,
  budgetTokens: number,
  countText: (text: string) => number,
): string {
  const total = countText(text)
  if (total <= budgetTokens) return text
  let cur = text
  for (let iter = 0; iter < 100; iter++) {
    const t = countText(cur)
    if (t <= budgetTokens) break
    // head+marker+tail: budget split across both halves, minus marker overhead
    const keepChars = Math.max(
      8,
      Math.floor((cur.length * budgetTokens) / (2 * Math.max(1, t))) - MARKER.length - 2,
    )
    const next = cutText(cur, keepChars, 'headtail')
    if (next.length >= cur.length) break
    cur = next
  }
  return cur
}

/** Summarize one message via the LLM; returns undefined when impossible so caller can truncate. */
async function summarizeLastMessage(
  text: string,
  budgetTokens: number,
  h: ShrinkHelpers,
  options: FitOptions,
): Promise<string | undefined> {
  if (!h.llm || !h.model) {
    h.report('fallback:no-llm')
    return undefined
  }
  try {
    const maxWords = options.lastMessageMaxWords ?? 200
    const transcript = truncateLastMessage(text, Math.max(64, budgetTokens + 500), (t) =>
      h.countText(t),
    )
    const res = await h.llm.chatCompletion({
      model: h.model,
      temperature: 0,
      messages: [
        { role: 'user', content: h.prompt('context.summarize', { transcript, maxWords }) },
      ],
      signal: h.signal,
    })
    const summary = res.content.trim()
    return summary ? `[Summary]\n${summary}` : undefined
  } catch (err) {
    h.report(`fallback:${err instanceof Error ? err.message : 'error'}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Config resolution (pure)
// ---------------------------------------------------------------------------

export interface ContextConfigLayer {
  maxTokens?: number
  contextLimit?: number
  reserve?: number
  strategies?: StrategySpec[]
  /** Oversize last user message handling (see `LastMessageStrategy`). */
  lastMessage?: LastMessageStrategy
  /** Use the model's known context window when no explicit limit is set. Default true. */
  autoLimit?: boolean
}

export interface ResolvedContextConfig {
  /** Effective input budget, or null when nothing is configured. */
  limit: number | null
  maxTokens?: number
  contextLimit?: number
  reserve: number
  strategies: StrategySpec[]
  lastMessage: LastMessageStrategy
  autoLimit: boolean
  sources: Record<string, string>
}

export interface ResolveContextConfigArgs {
  /** Per-item overrides (highest). */
  input?: ContextConfigLayer
  /** Tool factory options. */
  options?: ContextConfigLayer
  /** Envelope meta; reads `meta.context`. */
  meta?: Record<string, unknown>
  /** mt.json settings: `context.maxTokens`, `context.contextLimit`, `context.reserve`, `context.strategies`, `context.lastMessage`, `context.autoLimit`, `context.limits`. */
  settings?: Record<string, unknown>
  /** `MT_CONTEXT_MAX_TOKENS`, `MT_CONTEXT_LIMIT`, `MT_CONTEXT_RESERVE`, `MT_CONTEXT_STRATEGIES`, `MT_CONTEXT_LAST_MESSAGE`, `MT_CONTEXT_AUTO_LIMIT`, `MT_CONTEXT_LIMITS`. */
  env?: Record<string, string | undefined>
  /** Model's known context limit (used only when nothing else sets contextLimit). */
  modelLimit?: number
  /** Fallback reserve (e.g. request.maxTokens) when no layer sets one. */
  outputReserve?: number
}

function numOf(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

function stratList(v: unknown): StrategySpec[] | undefined {
  if (Array.isArray(v) && v.length > 0) return v as StrategySpec[]
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return undefined
}

const LAST_MESSAGE_VALUES: readonly LastMessageStrategy[] = [
  'off',
  'truncate',
  'summarize',
  'error',
]

function lastMessageOf(v: unknown): LastMessageStrategy | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const s = v.trim().toLowerCase()
  return (LAST_MESSAGE_VALUES as readonly string[]).includes(s)
    ? (s as LastMessageStrategy)
    : undefined
}

function boolOf(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (/^(1|true|yes|on)$/i.test(v)) return true
    if (/^(0|false|no|off)$/i.test(v)) return false
  }
  return undefined
}

function ctxLayer(raw: Record<string, unknown> | undefined): ContextConfigLayer {
  return {
    maxTokens: numOf(raw?.maxTokens),
    contextLimit: numOf(raw?.contextLimit),
    reserve: numOf(raw?.reserve),
    strategies: stratList(raw?.strategies),
    lastMessage: lastMessageOf(raw?.lastMessage),
    autoLimit: boolOf(raw?.autoLimit),
  }
}

/**
 * Pure. Precedence per field: input > options > meta.context > settings (`context.*`) > env > default.
 * `limit = min(maxTokens, contextLimit - reserve)` over whichever are set; null when neither is.
 */
export function resolveContextConfig(args: ResolveContextConfigArgs = {}): ResolvedContextConfig {
  const s = args.settings ?? {}
  const e = args.env ?? {}
  const layers: Array<[string, ContextConfigLayer]> = [
    ['input', ctxLayer(args.input as Record<string, unknown> | undefined)],
    ['options', ctxLayer(args.options as Record<string, unknown> | undefined)],
    ['meta', ctxLayer(args.meta?.context as Record<string, unknown> | undefined)],
    [
      'settings',
      ctxLayer({
        maxTokens: s['context.maxTokens'],
        contextLimit: s['context.contextLimit'],
        reserve: s['context.reserve'],
        strategies: s['context.strategies'],
        lastMessage: s['context.lastMessage'],
        autoLimit: s['context.autoLimit'],
      }),
    ],
    [
      'env',
      ctxLayer({
        maxTokens: e.MT_CONTEXT_MAX_TOKENS,
        contextLimit: e.MT_CONTEXT_LIMIT,
        reserve: e.MT_CONTEXT_RESERVE,
        strategies: e.MT_CONTEXT_STRATEGIES,
        lastMessage: e.MT_CONTEXT_LAST_MESSAGE,
        autoLimit: e.MT_CONTEXT_AUTO_LIMIT,
      }),
    ],
  ]
  const sources: Record<string, string> = {}
  function pick<K extends keyof ContextConfigLayer>(k: K): ContextConfigLayer[K] | undefined {
    for (const [name, l] of layers) {
      if (l[k] !== undefined) {
        sources[k] = name
        return l[k]
      }
    }
    return undefined
  }
  const maxTokens = pick('maxTokens')
  const contextLimit = pick('contextLimit') ?? args.modelLimit
  const reserve = pick('reserve') ?? args.outputReserve ?? 0
  const picked = pick('strategies')
  if (!picked) sources.strategies = 'default'
  const strategies = picked ?? DEFAULT_STRATEGIES
  const lastMessage = pick('lastMessage') ?? 'off'
  const autoLimit = pick('autoLimit') ?? true
  const candidates: number[] = []
  if (maxTokens !== undefined) candidates.push(maxTokens)
  if (contextLimit !== undefined) candidates.push(Math.max(0, contextLimit - reserve))
  return {
    limit: candidates.length > 0 ? Math.min(...candidates) : null,
    maxTokens,
    contextLimit,
    reserve,
    strategies,
    lastMessage,
    autoLimit,
    sources,
  }
}

// ---------------------------------------------------------------------------
// Model context-limit table (autoLimit)
// ---------------------------------------------------------------------------

export interface ModelContextLimitEntry {
  /** Glob-ish pattern: `*` matches anything; matched against the full id and the id without provider prefix (`openai/gpt-4o` -> also `gpt-4o`). */
  pattern: string
  limit: number
}

/**
 * Maintained best-effort table of model context windows (major families).
 * First match wins; user entries (option/env/settings) take precedence over
 * the whole table. Extend or correct via `MT_CONTEXT_LIMITS` / mt.json
 * `context.limits` without waiting for a release.
 */
export const MODEL_CONTEXT_LIMITS: ModelContextLimitEntry[] = [
  { pattern: 'claude*', limit: 200_000 },
  { pattern: 'gpt-5*', limit: 400_000 },
  { pattern: 'gpt-4.1*', limit: 1_000_000 },
  { pattern: 'gpt-4o*', limit: 128_000 },
  { pattern: 'o1*', limit: 200_000 },
  { pattern: 'o3*', limit: 200_000 },
  { pattern: 'o4*', limit: 200_000 },
  { pattern: 'gpt-4-turbo*', limit: 128_000 },
  { pattern: 'gpt-4-32k*', limit: 32_768 },
  { pattern: 'gpt-4*', limit: 8_192 },
  { pattern: 'gpt-3.5*', limit: 16_385 },
  { pattern: 'gemini-2.5*', limit: 1_000_000 },
  { pattern: 'gemini-2.0*', limit: 1_000_000 },
  { pattern: 'gemini-1.5*', limit: 1_000_000 },
  { pattern: 'gemini*', limit: 32_768 },
  { pattern: 'llama-4*', limit: 1_000_000 },
  { pattern: 'llama-3.3*', limit: 128_000 },
  { pattern: 'llama-3.2*', limit: 128_000 },
  { pattern: 'llama-3.1*', limit: 128_000 },
  { pattern: 'llama-3*', limit: 8_192 },
  { pattern: 'llama-2*', limit: 4_096 },
  { pattern: 'mistral-large*', limit: 128_000 },
  { pattern: 'mistral-small*', limit: 128_000 },
  { pattern: 'mistral-nemo*', limit: 128_000 },
  { pattern: 'devstral*', limit: 128_000 },
  { pattern: 'mixtral*', limit: 32_768 },
  { pattern: 'codestral*', limit: 32_768 },
  { pattern: 'ministral*', limit: 32_768 },
  { pattern: 'mistral*', limit: 32_768 },
  { pattern: 'deepseek*', limit: 65_536 },
  { pattern: 'qwen-max*', limit: 32_768 },
  { pattern: 'qwen*', limit: 128_000 },
]

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchOneLimit(model: string, pattern: string): boolean {
  const bare = model.includes('/') ? (model.split('/').pop() as string) : model
  const re = globToRegExp(pattern.trim())
  return re.test(model) || re.test(bare)
}

/** Parse a user limit table: JSON string or object `{ "pattern": number }`. */
export function parseContextLimits(v: unknown): Record<string, number> | undefined {
  let raw: unknown = v
  if (typeof v === 'string') {
    if (!v.trim()) return undefined
    try {
      raw = JSON.parse(v)
    } catch {
      return undefined
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(raw)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = n
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Best-effort known context window for a model id (undefined when unknown).
 * `limits` (and env `MT_CONTEXT_LIMITS` / settings `context.limits` when passed
 * via createFitter) override the built-in table; first match wins.
 */
export function modelContextLimit(
  model: string | undefined,
  limits?: Record<string, number>,
): number | undefined {
  if (!model) return undefined
  if (limits) {
    for (const [pattern, limit] of Object.entries(limits)) {
      if (matchOneLimit(model, pattern)) return limit
    }
  }
  for (const { pattern, limit } of MODEL_CONTEXT_LIMITS) {
    if (matchOneLimit(model, pattern)) return limit
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fitter (shared by the contextWindow tool and the gate `fit` slot)
// ---------------------------------------------------------------------------

export interface ContextWindowOptions extends ContextConfigLayer {
  countTokens?: (text: string) => number
  preserveSystem?: boolean
  preserveLastUser?: boolean
  /**
   * Look up the model's known context window when no explicit limit is configured.
   * Default true: a known model id implies a budget. Disable with `autoLimit: false`
   * / `MT_CONTEXT_AUTO_LIMIT=0` / settings `context.autoLimit: false`.
   */
  autoLimit?: boolean
  /** Words budget for `lastMessage: 'summarize'`. Default 200. */
  lastMessageMaxWords?: number
  /** `'throw'` raises LlmContextLengthError when the result still does not fit. Default `'pass'`. */
  onOverflow?: 'pass' | 'throw'
  /** Client for `summarize` (instance or factory). Default: created from LLM config (ctx/meta/env). */
  llm?: LlmClient | ((ctx: ToolContext | undefined, meta: Record<string, unknown>) => LlmClient)
  /** LLM config layer used when creating the summarize client. */
  llmConfig?: LlmConfigLayer
  /** Prompt overrides (e.g. `{ 'context.summarize': '@prompts/sum.md' }`). */
  prompts?: Record<string, string>
  /** Model used for the summarize call. Default: request model / resolved LLM config model. */
  model?: string
}

export interface FitArgs {
  messages: LlmMessage[]
  ctx?: ToolContext
  meta?: Record<string, unknown>
  /** Per-item config overrides. */
  input?: ContextConfigLayer
  model?: string
  outputReserve?: number
  /** Force a smaller limit (used by shrink-and-retry). */
  limitOverride?: number
  /** Override `preserveLastUser` for this call (plain-text items are not protected). */
  preserveLastUser?: boolean
  signal?: AbortSignal
  /** Override the resolved `lastMessage` strategy for this call. */
  lastMessage?: LastMessageStrategy
}

export type Fitter = (
  args: FitArgs,
) => Promise<{ messages: LlmMessage[]; record: ContextWindowRecord }>

export function createFitter(options: ContextWindowOptions = {}): Fitter {
  return async (args) => {
    const view = readCtx(args.ctx)
    const meta = args.meta ?? {}
    const userLimits = {
      ...parseContextLimits(view.settings['context.limits']),
      ...parseContextLimits(view.env.MT_CONTEXT_LIMITS),
    }
    // autoLimit comes from the same layered resolution as the budget; probe it
    // first (cheap, pure) so the model table only applies when enabled.
    const autoProbe = resolveContextConfig({
      input: args.input,
      options,
      meta,
      settings: view.settings,
      env: view.env,
      outputReserve: args.outputReserve,
    })
    const cfg = resolveContextConfig({
      input: args.input,
      options,
      meta,
      settings: view.settings,
      env: view.env,
      modelLimit: autoProbe.autoLimit ? modelContextLimit(args.model, userLimits) : undefined,
      outputReserve: args.outputReserve,
    })
    const limit =
      args.limitOverride !== undefined
        ? cfg.limit === null
          ? args.limitOverride
          : Math.min(cfg.limit, args.limitOverride)
        : cfg.limit

    let llm: LlmClient | undefined
    const lazy: LlmClient = {
      chatCompletion: (req) => {
        if (!llm) {
          llm =
            typeof options.llm === 'function'
              ? options.llm(args.ctx, meta)
              : (options.llm ??
                createLlmClient(
                  resolveLlmConfigFromCtx(args.ctx, { tool: options.llmConfig, meta }),
                  args.ctx,
                ))
        }
        return llm.chatCompletion(req)
      },
    }
    const ps = promptSourcesFromCtx(args.ctx, { tool: options.prompts, meta })
    const sources: PromptSources = ps.sources
    const result = await fitMessages(args.messages, {
      limit,
      strategies: cfg.strategies,
      countTokens: options.countTokens,
      preserveSystem: options.preserveSystem,
      preserveLastUser: args.preserveLastUser ?? options.preserveLastUser,
      llm: lazy,
      model: options.model ?? args.model ?? resolveLlmConfigFromCtx(args.ctx, { meta }).model,
      prompt: (name, vars) => resolvePrompt(name, vars, sources, ps.env),
      signal: args.signal,
      lastMessage: args.lastMessage ?? cfg.lastMessage,
      lastMessageMaxWords: options.lastMessageMaxWords,
    })
    if (!result.record.fits && options.onOverflow === 'throw') {
      throw new LlmContextLengthError(
        `Messages still exceed budget after shrinking: ${result.record.after} > ${result.record.budget} tokens`,
      )
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface ContextWindowItemObject {
  messages: LlmMessage[]
  /** Per-item overrides of maxTokens / contextLimit / reserve / strategies. */
  context?: ContextConfigLayer
  model?: string
  /** Output token cap; used as the default reserve. */
  maxTokens?: number
  [k: string]: unknown
}

/** Accepted item shapes; output keeps the input shape. */
export type ContextWindowItem = string | LlmMessage[] | ContextWindowItemObject

/**
 * Tool placed before an LLM call: shrinks messages to a token budget with ordered strategies.
 * Records `meta.contextWindow` ({before, after, budget, fits, applied[]}; array for batches).
 */
export function createContextWindow(
  options: ContextWindowOptions & { name?: string } = {},
): Tool<ContextWindowItem, ContextWindowItem> {
  const fit = createFitter(options)
  return defineTool<ContextWindowItem, ContextWindowItem>({
    name: options.name ?? 'context-window',
    version: '1.0.0',
    mdDescription:
      'Shrinks chat messages to a token budget using ordered strategies ' +
      '(truncateLines, summarize, dropOldest, ...). Preserves system + last user message. ' +
      'Records meta.contextWindow.',
    async invoke(
      env: Envelope<ContextWindowItem>,
      ctx: ToolContext,
    ): Promise<Envelope<ContextWindowItem>> {
      const inputs = env.items ?? [env.item]
      const outputs: ContextWindowItem[] = []
      const records: ContextWindowRecord[] = []
      for (const item of inputs) {
        const obj = typeof item === 'string' || Array.isArray(item) ? undefined : item
        const messages: LlmMessage[] =
          typeof item === 'string'
            ? [{ role: 'user', content: item }]
            : Array.isArray(item)
              ? item
              : item.messages
        const { messages: fitted, record } = await fit({
          messages,
          ctx,
          meta: env.meta,
          input: obj?.context,
          model: obj?.model,
          outputReserve: obj?.maxTokens,
          preserveLastUser: typeof item === 'string' ? false : undefined,
        })
        records.push(record)
        outputs.push(
          typeof item === 'string'
            ? (fitted[0]?.content ?? '')
            : Array.isArray(item)
              ? fitted
              : { ...item, messages: fitted },
        )
      }
      const meta = {
        ...env.meta,
        contextWindow: env.items ? records : records[0],
      }
      return env.items
        ? { item: outputs[0] as ContextWindowItem, items: outputs, meta }
        : { item: outputs[0] as ContextWindowItem, meta }
    },
  })
}

/** Default instance (budget from meta.context / mt.json / env). */
export const contextWindow = createContextWindow()
/** Alias of `contextWindow`. */
export const contextShrink = contextWindow
