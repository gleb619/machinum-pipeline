import { defineComposableTool, defineTool } from '@mt/core'
import type { ComposableTool, Envelope, Tool, ToolContext } from '@mt/core'
import {
  type CacheLike,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmResponseFormat,
  type LlmTransport,
  type LlmUsage,
  createLlmClient,
} from '../modification/llm-client.js'
import {
  type LlmConfigLayer,
  type ResolvedLlmConfig,
  resolveLlmConfigFromCtx,
} from '../modification/llm-config.js'
import {
  type ContextConfigLayer,
  type ContextWindowOptions,
  type ContextWindowRecord,
  createFitter,
} from '../modification/llm-context.js'
import {
  type PromptSources,
  promptSourcesFromCtx,
  resolvePrompt,
} from '../modification/llm-prompts.js'
import { LlmContextLengthError, LlmParseError } from './llm-errors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Superset of ChatCompletionInput / PromptInput; what `prepare` understands. */
export interface GateInput {
  messages?: LlmMessage[]
  /** User prompt text (single user message). */
  prompt?: string
  /** System prompt text (prepended as a system message). */
  systemPrompt?: string
  /** Named template for the user message (see llm-prompts). */
  promptName?: string
  /** Named template for the system message. */
  systemPromptName?: string
  vars?: Record<string, unknown>
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: LlmResponseFormat
  /** Per-call LLM config overrides (highest precedence). */
  llm?: LlmConfigLayer
  /** Per-call context-window overrides. */
  context?: ContextConfigLayer
}

/**
 * Value that travels between gate slots in `env.item` (or `env.items` for batches).
 * Custom slots can read/replace any field; keep `request` and `response` coherent.
 */
export interface GateState<In = unknown> {
  input: In
  /** LLM config layer from the call input (model + `input.llm`). */
  llmLayer?: LlmConfigLayer
  request?: LlmRequest
  response?: LlmResponse
  json?: unknown
  fit?: ContextWindowRecord[]
  usage: LlmUsage & { calls: number; cached: number }
  /** Set by `fit`: re-fit `request` to `factor` x its current token size (shrink-and-retry). */
  refit?: (
    state: GateState<In>,
    factor: number,
  ) => Promise<{ request: LlmRequest; fit: ContextWindowRecord } | undefined>
  /** Set by `call`: lets `parse` re-ask the model (corrective JSON retry). */
  invoke?: (req: LlmRequest) => Promise<LlmResponse>
}

export type GateSlot = 'prepare' | 'fit' | 'call' | 'parse' | 'emit'

export interface LlmGateOptions<I, O> {
  name: string
  version?: string
  mdDescription?: string
  /** Tool-level LLM config (below per-call input, above meta/settings/env). */
  llm?: LlmConfigLayer
  /** Prompt template overrides for this tool: `{ name: text | '@file' }`. */
  prompts?: Record<string, string>
  /** Context-window options for the `fit` slot (no budget configured = no-op). */
  context?: ContextWindowOptions
  /** Inject a client (or factory) instead of building one from config. Used as-is (no decorators). */
  client?: LlmClient | ((cfg: ResolvedLlmConfig, ctx: ToolContext | undefined) => LlmClient)
  /** Replace HTTP for the built client (tests). */
  transport?: LlmTransport
  /** Replace the cache for the built client. */
  cache?: CacheLike
  responseFormat?: LlmResponseFormat
  /** JSON-parse corrective retries. Default 2. */
  jsonRetries?: number
  /** Validate/convert parsed JSON; throw to reject (zod `schema.parse` fits). */
  validate?: (json: unknown) => unknown
  /** Custom parser for the response content (replaces JSON extraction). */
  parse?: (content: string) => unknown
  /** On context-length error, shrink via the `fit` slot and retry. `true` = 2 attempts. Default off. */
  shrinkOnContextError?: boolean | number
  /**
   * Stream via `client.chatCompletionStream` when the transport supports it
   * (SDK transports); the aggregated result is identical to non-streaming.
   * Falls back to `chatCompletion` otherwise.
   */
  stream?: boolean
  /** Called with each content delta while streaming (and the original input). */
  onDelta?: (delta: string, input: I) => void
  /** Map the tool input to a GateInput. Default: identity. */
  normalize?: (input: I) => GateInput
  /** Map the final state to the tool output. Default: chat-completion shaped output. */
  toOutput?: (state: GateState<I>, input: I) => O
  /** Extra meta flags added by `emit` (e.g. `{ chatCompletion: true }`). */
  metaFlags?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mapEnv<A, B>(
  env: Envelope<A>,
  fn: (a: A, index: number) => Promise<B>,
): Promise<Envelope<B>> {
  const inputs = env.items ?? [env.item]
  const out: B[] = []
  for (let i = 0; i < inputs.length; i++) out.push(await fn(inputs[i] as A, i))
  return env.items
    ? { item: out[0] as B, items: out, meta: env.meta }
    : { item: out[0] as B, meta: env.meta }
}

const zeroUsage = (): GateState['usage'] => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
  cached: 0,
})

function addUsage(u: GateState['usage'], r: LlmResponse): GateState['usage'] {
  const cost = (u.costUsd ?? 0) + (r.usage.costUsd ?? 0)
  return {
    promptTokens: u.promptTokens + r.usage.promptTokens,
    completionTokens: u.completionTokens + r.usage.completionTokens,
    totalTokens: u.totalTokens + r.usage.totalTokens,
    ...(r.usage.costUsd !== undefined || u.costUsd !== undefined ? { costUsd: cost } : {}),
    calls: u.calls + 1,
    cached: u.cached + (r.cached ? 1 : 0),
  }
}

/** Pull the first JSON value out of model text (handles ``` fences and surrounding prose). */
export function extractJson(content: string): unknown {
  const text = content.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [text]
  if (fenced?.[1]) candidates.unshift(fenced[1].trim())
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // try next
    }
  }
  const start = text.search(/[[{]/)
  if (start >= 0) {
    const open = text[start] as string
    const close = open === '{' ? '}' : ']'
    const end = text.lastIndexOf(close)
    if (end > start) return JSON.parse(text.slice(start, end + 1))
  }
  throw new SyntaxError('no JSON value found in model output')
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** `prepare`: tool input -> GateState with a fully resolved LlmRequest (prompts + model). */
export function llmPrepare<I, O>(opts: LlmGateOptions<I, O>): Tool<I, GateState<I>> {
  return defineTool<I, GateState<I>>({
    name: `${opts.name}:prepare`,
    version: opts.version ?? '1.0.0',
    mdDescription: 'Resolves prompts (overridable templates) and request parameters.',
    async invoke(env, ctx) {
      const ps = promptSourcesFromCtx(ctx, { tool: opts.prompts, meta: env.meta })
      return mapEnv(env, async (input) => {
        const g = (opts.normalize ? opts.normalize(input) : input) as GateInput
        const vars = g.vars ?? {}
        const messages: LlmMessage[] = []
        const sys =
          g.systemPrompt ??
          (g.systemPromptName
            ? resolvePrompt(g.systemPromptName, vars, ps.sources, ps.env)
            : undefined)
        if (sys) messages.push({ role: 'system', content: sys })
        if (g.messages) messages.push(...g.messages)
        const user =
          g.prompt ??
          (g.promptName ? resolvePrompt(g.promptName, vars, ps.sources, ps.env) : undefined)
        if (user !== undefined) messages.push({ role: 'user', content: user })

        const llmLayer: LlmConfigLayer = { ...g.llm, ...(g.model ? { model: g.model } : {}) }
        const cfg = resolveLlmConfigFromCtx(ctx, {
          input: llmLayer,
          tool: opts.llm,
          meta: env.meta,
        })
        const request: LlmRequest = {
          messages,
          model: cfg.model,
          ...(g.temperature !== undefined || cfg.temperature !== undefined
            ? { temperature: g.temperature ?? cfg.temperature }
            : {}),
          ...(g.maxTokens !== undefined || cfg.maxTokens !== undefined
            ? { maxTokens: g.maxTokens ?? cfg.maxTokens }
            : {}),
          ...((g.responseFormat ?? opts.responseFormat)
            ? { responseFormat: g.responseFormat ?? opts.responseFormat }
            : {}),
        }
        return { input, llmLayer, request, usage: zeroUsage() } satisfies GateState<I>
      })
    },
  })
}

/** `fit`: shrink `request.messages` to the configured token budget (no-op without a budget). */
export function llmFit<I, O>(opts: LlmGateOptions<I, O>): Tool<GateState<I>, GateState<I>> {
  const fitter = createFitter(opts.context)
  return defineTool<GateState<I>, GateState<I>>({
    name: `${opts.name}:fit`,
    version: opts.version ?? '1.0.0',
    mdDescription: 'Fits messages into the context budget (strategies: see llm-context).',
    async invoke(env, ctx) {
      return mapEnv(env, async (state) => {
        const request = state.request
        if (!request) return state
        const g = state.input as GateInput
        const run = (messages: LlmMessage[], limitOverride?: number): ReturnType<typeof fitter> =>
          fitter({
            messages,
            ctx,
            meta: env.meta,
            input: g.context,
            model: request.model,
            outputReserve: request.maxTokens,
            limitOverride,
          })
        const { messages, record } = await run(request.messages)
        const refit: GateState<I>['refit'] = async (st, factor) => {
          const cur = st.request
          if (!cur) return undefined
          const probe = await run(cur.messages, Number.MAX_SAFE_INTEGER)
          const target = Math.max(1, Math.floor(probe.record.before * factor))
          const r = await run(cur.messages, target)
          if (r.record.after >= r.record.before) return undefined
          return { request: { ...cur, messages: r.messages }, fit: r.record }
        }
        return {
          ...state,
          request: { ...request, messages },
          fit: record.budget === null ? state.fit : [...(state.fit ?? []), record],
          refit,
        }
      })
    },
  })
}

function shrinkAttempts(v: boolean | number | undefined): number {
  if (v === true) return 2
  if (typeof v === 'number') return Math.max(0, Math.floor(v))
  return 0
}

/**
 * Shared call loop: invoke the client, on context-length error optionally refit + retry.
 * Exported so custom/mock `call` slots get identical semantics.
 */
export async function runLlmCall<I>(
  state: GateState<I>,
  invoke: (req: LlmRequest) => Promise<LlmResponse>,
  shrinkOnContextError?: boolean | number,
): Promise<GateState<I>> {
  if (!state.request) throw new Error('llm call slot: state.request missing (did prepare run?)')
  let request = state.request
  let fit = state.fit
  const max = shrinkAttempts(shrinkOnContextError)
  let tries = 0
  for (;;) {
    try {
      const response = await invoke(request)
      return {
        ...state,
        request,
        response,
        fit,
        usage: addUsage(state.usage, response),
        invoke,
      }
    } catch (err) {
      if (!(err instanceof LlmContextLengthError) || !state.refit || tries >= max) throw err
      const shrunk = await state.refit({ ...state, request }, 0.75)
      if (!shrunk) throw err
      tries++
      request = shrunk.request
      fit = [...(fit ?? []), shrunk.fit]
    }
  }
}

/** `call`: send `state.request` through the (decorated) LlmClient. */
export function llmCall<I, O>(opts: LlmGateOptions<I, O>): Tool<GateState<I>, GateState<I>> {
  return defineTool<GateState<I>, GateState<I>>({
    name: `${opts.name}:call`,
    version: opts.version ?? '1.0.0',
    mdDescription: 'Calls the LLM (timeout, retry, optional cache; provider from config).',
    async invoke(env, ctx) {
      return mapEnv(env, async (state) => {
        const cfg = resolveLlmConfigFromCtx(ctx, {
          input: state.llmLayer,
          tool: opts.llm,
          meta: env.meta,
        })
        const client =
          typeof opts.client === 'function'
            ? opts.client(cfg, ctx)
            : (opts.client ??
              createLlmClient(cfg, ctx, { transport: opts.transport, cache: opts.cache }))
        const streamFn =
          opts.stream && typeof client.chatCompletionStream === 'function'
            ? client.chatCompletionStream
            : undefined
        const invoke = (req: LlmRequest): Promise<LlmResponse> =>
          streamFn
            ? streamFn.call(
                client,
                req,
                opts.onDelta ? (d) => opts.onDelta?.(d, state.input) : undefined,
              )
            : client.chatCompletion(req)
        return runLlmCall(state, invoke, opts.shrinkOnContextError)
      })
    },
  })
}

/** `parse`: JSON mode / custom parser with bounded corrective retries. */
export function llmParse<I, O>(opts: LlmGateOptions<I, O>): Tool<GateState<I>, GateState<I>> {
  const retries = opts.jsonRetries ?? 2
  return defineTool<GateState<I>, GateState<I>>({
    name: `${opts.name}:parse`,
    version: opts.version ?? '1.0.0',
    mdDescription: 'Parses/validates output; on JSON failure re-asks with a corrective message.',
    async invoke(env, ctx) {
      const ps = promptSourcesFromCtx(ctx, { tool: opts.prompts, meta: env.meta })
      return mapEnv(env, async (state) => {
        const wantsParse = state.request?.responseFormat === 'json' || opts.parse || opts.validate
        if (!wantsParse || !state.response || !state.request) return state
        let cur = state
        const parser = opts.parse ?? extractJson
        for (let attempt = 0; ; attempt++) {
          const content = (cur.response as LlmResponse).content
          try {
            let json = parser(content)
            if (opts.validate) json = opts.validate(json)
            return { ...cur, json }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            if (attempt >= retries || !cur.invoke) {
              throw new LlmParseError(
                `Could not parse model output after ${attempt + 1} attempt(s): ${reason}`,
                content,
                { cause: err },
              )
            }
            const correction = resolvePrompt(
              'json.correction',
              { error: reason },
              ps.sources as PromptSources,
              ps.env,
            )
            const request: LlmRequest = {
              ...(cur.request as LlmRequest),
              messages: [
                ...(cur.request as LlmRequest).messages,
                { role: 'assistant', content },
                { role: 'user', content: correction },
              ],
            }
            const response = await cur.invoke(request)
            cur = { ...cur, request, response, usage: addUsage(cur.usage, response) }
          }
        }
      })
    },
  })
}

/** Default output shape (chat-completion compatible). */
export interface GateOutput {
  content: string
  model: string
  tokens: number
  promptTokens: number
  completionTokens: number
  /** Parsed JSON when JSON mode / parser / validator is active. */
  json?: unknown
}

function defaultOutput<I>(state: GateState<I>): GateOutput {
  const r = state.response
  if (!r) throw new Error('llm emit slot: state.response missing (did call run?)')
  return {
    content: r.content,
    model: r.model,
    tokens: r.usage.totalTokens,
    promptTokens: r.usage.promptTokens,
    completionTokens: r.usage.completionTokens,
    ...(state.json !== undefined ? { json: state.json } : {}),
  }
}

/** `emit`: GateState -> tool output; records `meta.llmUsage` and `meta.contextWindow`. */
export function llmEmit<I, O>(opts: LlmGateOptions<I, O>): Tool<GateState<I>, O> {
  return defineTool<GateState<I>, O>({
    name: `${opts.name}:emit`,
    version: opts.version ?? '1.0.0',
    mdDescription: 'Shapes the final output and records usage/context metadata.',
    async invoke(env) {
      const states = env.items ?? [env.item]
      const results = states.map((s) =>
        opts.toOutput ? opts.toOutput(s, s.input) : (defaultOutput(s) as unknown as O),
      )
      const usage = zeroUsage()
      for (const s of states) {
        usage.promptTokens += s.usage.promptTokens
        usage.completionTokens += s.usage.completionTokens
        usage.totalTokens += s.usage.totalTokens
        usage.calls += s.usage.calls
        usage.cached += s.usage.cached
        if (s.usage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + s.usage.costUsd
      }
      const fits = states.map((s) => s.fit)
      const meta: Envelope<O>['meta'] = {
        ...env.meta,
        ...opts.metaFlags,
        count: results.length,
        llmUsage: usage,
      }
      if (fits.some((f) => f && f.length > 0)) {
        const last = fits.map((f) => f?.[f.length - 1])
        meta.contextWindow = env.items ? last : last[0]
      }
      return { item: (env.items ? results : results[0]) as O, meta }
    },
  })
}

// ---------------------------------------------------------------------------
// Gate factory
// ---------------------------------------------------------------------------

/**
 * LLM gate = composable tool with slots `prepare -> fit -> call -> parse -> emit`.
 * Swap any part: `gate.with({ call: mockLlmCall(['ok']) })`, `gate.with({ fit: myFit })`.
 */
export function createLlmGate<I = GateInput, O = GateOutput>(
  opts: LlmGateOptions<I, O>,
): ComposableTool<I, O, GateSlot> {
  return defineComposableTool<I, O, GateSlot>({
    name: opts.name,
    version: opts.version ?? '1.0.0',
    mdDescription:
      opts.mdDescription ??
      'LLM gate: prepare (prompts) -> fit (context window) -> call (LlmClient) -> parse -> emit.',
    slots: {
      prepare: llmPrepare(opts) as Tool<unknown, unknown>,
      fit: llmFit(opts) as Tool<unknown, unknown>,
      call: llmCall(opts) as Tool<unknown, unknown>,
      parse: llmParse(opts) as Tool<unknown, unknown>,
      emit: llmEmit(opts) as Tool<unknown, unknown>,
    },
  })
}

/** Generic gate: GateInput in, chat-completion shaped output (+ `json`). */
export const llmGate = createLlmGate<GateInput, GateOutput>({
  name: 'llm-gate',
  mdDescription:
    'Generic LLM gate with swappable slots prepare/fit/call/parse/emit. Provider, model, prompts and context budget are configurable (see docs/steering/tools.md).',
  metaFlags: { llmGate: true },
})

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export type MockAnswer = string | Partial<LlmResponse> | Error
export type MockSource =
  | MockAnswer[]
  | ((req: LlmRequest, index: number) => MockAnswer | Promise<MockAnswer>)

export interface MockLlmClient extends LlmClient {
  /** Requests received, in order. */
  readonly calls: LlmRequest[]
}

/** Scripted client: array (last answer repeats when exhausted) or function. Errors are thrown. */
export function mockLlmClient(source: MockSource = ['mock']): MockLlmClient {
  const calls: LlmRequest[] = []
  return {
    calls,
    async chatCompletion(req) {
      const i = calls.length
      calls.push(req)
      const answer =
        typeof source === 'function'
          ? await source(req, i)
          : (source[Math.min(i, source.length - 1)] ?? 'mock')
      if (answer instanceof Error) throw answer
      const partial: Partial<LlmResponse> =
        typeof answer === 'string' ? { content: answer } : answer
      const content = partial.content ?? ''
      const promptTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4)
      const completionTokens = Math.ceil(content.length / 4)
      return {
        content,
        model: partial.model ?? req.model,
        usage: partial.usage ?? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: partial.finishReason ?? 'stop',
      }
    },
  }
}

export type MockLlmCall = Tool<GateState, GateState> & { readonly calls: LlmRequest[] }

/**
 * Drop-in `call` slot that never touches the network:
 * `gate.with({ call: mockLlmCall(['answer 1', 'answer 2']) })` or `mockLlmCall((req) => ...)`.
 */
export function mockLlmCall(
  source: MockSource = ['mock'],
  options: { shrinkOnContextError?: boolean | number } = {},
): MockLlmCall {
  const client = mockLlmClient(source)
  const tool = defineTool<GateState, GateState>({
    name: 'mock-llm-call',
    version: '1.0.0',
    mdDescription: 'Mock `call` slot: scripted LLM answers, no network.',
    async invoke(env) {
      return mapEnv(env, (state) =>
        runLlmCall(state, (req) => client.chatCompletion(req), options.shrinkOnContextError),
      )
    },
  })
  return Object.assign(tool, { calls: client.calls })
}
