import { createHash } from 'node:crypto'
import { defineTool, setVariable, withItem } from '@mt/core'
import type { Exchange, Tool } from '@mt/core'
import { type LlmClient, createLlmClient } from './llm-client.js'
import {
  type LlmConfigLayer,
  type ResolvedLlmConfig,
  exchangeConfigBag,
  resolveLlmConfigFromCtx,
} from './llm-config.js'
import { LlmError, LlmQuotaError, LlmRateLimitError } from './llm-errors.js'
import {
  type GateInput,
  type GateOutput,
  type GateState,
  createLlmGate,
  llmEmit,
  llmPrepare,
} from './llm-gate.js'
import { sharedPoolFor } from './openrouter-pool.js'

export const OPENROUTER_POOL_DEFAULT_MODELS: readonly string[] = ['openrouter/free']

export type PinStrategy = 'first' | 'random'

export interface OpenrouterPoolOptions {
  /** Candidate free models. Default `['openrouter/free']`. */
  models?: string[]
  /** How the first pin is chosen. Default `first`. Re-pins always walk to the next candidate. */
  strategy?: PinStrategy
  /** Inner client (tests / custom transport). Default: `createLlmClient(cfg, ctx)`. */
  client?: LlmClient | ((cfg: ResolvedLlmConfig, ctx: unknown) => LlmClient)
}

/** Variable holding the pool snapshot. */
export const VAR_OPENROUTER_POOL = 'openrouterPool'

/** Recorded in the `openrouterPool` variable. */
export interface OpenrouterPoolMeta {
  model: string
  pinnedAt: number
  repins: number
}

interface Pin {
  candidates: string[]
  index: number
  pinnedAt: number
  repins: number
}

type PooledState = GateState<GateInput> & { pinId?: string }

const pins = new Map<string, Pin>()

/** Forget every pinned model (tests). */
export function resetOpenrouterPoolPins(): void {
  pins.clear()
}

/** Pin snapshot for a key-set (undefined when nothing is pinned yet). */
export function getOpenrouterPoolPin(id: string): OpenrouterPoolMeta | undefined {
  const p = pins.get(id)
  return p ? snapshot(p) : undefined
}

const model = (p: Pin): string => p.candidates[p.index] as string
const snapshot = (p: Pin): OpenrouterPoolMeta => ({
  model: model(p),
  pinnedAt: p.pinnedAt,
  repins: p.repins,
})

function pinId(cfg: ResolvedLlmConfig): string {
  return createHash('sha256')
    .update(`${cfg.baseUrl}\n${cfg.apiKeys.join('\n')}`)
    .digest('hex')
}

function pinFor(id: string, candidates: string[], strategy: PinStrategy): Pin {
  let pin = pins.get(id)
  if (!pin) {
    const index = strategy === 'random' ? Math.floor(Math.random() * candidates.length) : 0
    pin = { candidates, index, pinnedAt: Date.now(), repins: 0 }
    pins.set(id, pin)
  }
  return pin
}

/** 404 (model unavailable), 402 (quota), or 429 with every key blocked. */
function shouldRepin(err: unknown, cfg: ResolvedLlmConfig): boolean {
  if (err instanceof LlmQuotaError) return true
  if (err instanceof LlmRateLimitError) {
    if (cfg.apiKeys.length === 0) return true
    return sharedPoolFor(cfg.apiKeys, cfg.baseUrl).getPool().availableSize() === 0
  }
  return err instanceof LlmError && err.status === 404
}

function pinnedClient(
  inner: LlmClient,
  cfg: ResolvedLlmConfig,
  id: string,
  candidates: string[],
  strategy: PinStrategy,
): LlmClient {
  return {
    async chatCompletion(req) {
      const pin = pinFor(id, candidates, strategy)
      // Per-call override: pass through, never touch the pin.
      if (req.model !== model(pin)) return inner.chatCompletion(req)
      const failed = new Set<string>()
      let current = req.model
      for (;;) {
        try {
          return await inner.chatCompletion({ ...req, model: current })
        } catch (err) {
          if (!shouldRepin(err, cfg)) throw err
          failed.add(current)
          if (model(pin) === current) {
            // we own this failure: advance to the next candidate not yet failed in this call
            let next = -1
            for (let i = 1; i < pin.candidates.length; i++) {
              const idx = (pin.index + i) % pin.candidates.length
              if (!failed.has(pin.candidates[idx] as string)) {
                next = idx
                break
              }
            }
            if (next < 0) throw err
            pin.index = next
            pin.repins++
            pin.pinnedAt = Date.now()
          } else if (failed.has(model(pin))) {
            throw err
          }
          current = model(pin)
        }
      }
    },
  }
}

/**
 * Sources of a resolved model that leave the sticky pin in charge: nothing above the preset
 * defaults chose a model, so `candidates` own it.
 */
const PINNABLE_MODEL_SOURCES = new Set(['preset-defaults', 'default'])

/**
 * Build an `openrouterPool` gate: like `openrouterFree`, but the first call pins ONE free model
 * (per key-set, module-level, process-wide) that every later call reuses. Re-pins to the next
 * candidate only on 404 (model unavailable), 429 with all keys blocked, or 402 (quota).
 *
 * The candidates are a **default, not a pin** (same layering as `openrouterFree`: the first one is
 * passed as `llmDefaults`, only the provider sits on the tool layer). The pin applies only when no
 * higher layer picked a model, so a per-call `model` / `llm.model`, `llm.model` variable, mt.json
 * `llm.model`, `MT_OLLAMA_MODEL` or a vault ref (`llm.use`) wins and leaves the pin map untouched.
 */
export function createOpenrouterPool(options: OpenrouterPoolOptions = {}) {
  const candidates = options.models?.length
    ? [...options.models]
    : [...OPENROUTER_POOL_DEFAULT_MODELS]
  const strategy = options.strategy ?? 'first'
  const llm: LlmConfigLayer = { provider: 'openrouter' }
  const llmDefaults: LlmConfigLayer = { model: candidates[0] as string }

  const gateOpts = {
    name: 'openrouter-pool',
    version: '1.0.0',
    mdDescription:
      'OpenRouter free-model gate with sticky pinning: one model per key-set (default, overridable by any ' +
      'higher config layer), re-pinned only on 404/429-exhausted/402.',
    llm,
    llmDefaults,
    metaFlags: { openrouterPoolTool: true },
    client: (cfg: ResolvedLlmConfig, ctx: unknown): LlmClient => {
      const base =
        typeof options.client === 'function'
          ? options.client(cfg, ctx)
          : (options.client ?? createLlmClient(cfg, ctx as never))
      return pinnedClient(base, cfg, pinId(cfg), candidates, strategy)
    },
  }

  const basePrepare = llmPrepare<GateInput, GateOutput>(gateOpts)
  const prepare = defineTool<GateInput, GateState<GateInput>>({
    name: 'openrouter-pool:prepare',
    version: '1.0.0',
    mdDescription: 'Base prepare + sticky pinned model unless the call overrides it.',
    async invoke(env, ctx) {
      const out = (await basePrepare.invoke(env, ctx)) as Exchange<PooledState>
      const states = out.items ?? [out.item]
      const next = states.map((s): PooledState => {
        if (!s.request) return s

        const cfg = resolveLlmConfigFromCtx(ctx, {
          input: s.llmLayer,
          tool: llm,
          defaults: llmDefaults,
          meta: exchangeConfigBag(env),
        })
        // The model is a default, not a pin: any layer above the preset defaults (per-call input,
        // `llm` variable, mt.json `llm.model`, vault ref, provider env) already chose it, so the
        // sticky free-model pin must not override it and must not touch the pin map.
        if (!PINNABLE_MODEL_SOURCES.has(cfg.sources.model ?? 'default')) return s
        const id = pinId(cfg)
        const pin = pinFor(id, candidates, strategy)
        return { ...s, pinId: id, request: { ...s.request, model: model(pin) } }
      })
      const derived = withItem(out, next[0] as PooledState)
      return out.items ? { ...derived, items: next } : derived
    },
  }) as Tool<unknown, unknown>

  const baseEmit = llmEmit<GateInput, GateOutput>(gateOpts)
  const emit = defineTool<GateState<GateInput>, GateOutput>({
    name: 'openrouter-pool:emit',
    version: '1.0.0',
    mdDescription: 'Base emit + openrouterPool variable = { model, pinnedAt, repins }.',
    async invoke(env, ctx) {
      const out = await baseEmit.invoke(env, ctx)
      const states = (env.items ?? [env.item]) as PooledState[]
      const id = states.find((s) => s.pinId)?.pinId
      const pin = id ? pins.get(id) : undefined
      return pin ? setVariable(out, VAR_OPENROUTER_POOL, snapshot(pin)) : out
    },
  }) as Tool<unknown, unknown>

  return createLlmGate<GateInput, GateOutput>(gateOpts).with({ prepare, emit })
}

/** Default sticky free-model gate (`openrouter/free`). */
export const openrouterPool = createOpenrouterPool()
