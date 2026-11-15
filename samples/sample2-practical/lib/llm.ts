import { resolve } from 'node:path'
import { createConsoleLogger, readMtConfigSync } from '@mt/core'
import {
  type LlmChoice,
  type LlmConfigLayer,
  type MockSource,
  type PickLlmToolOptions,
  mockLlmChoice,
  mockLlmClient,
  pickLlmTool,
  readLlmConfig,
} from '@mt/tools'

/**
 * The single LLM config point of the sample: every pipe picks its backend here.
 *
 * `MT_LLM_TOOL` / `MT_LLM_MODEL` or mt.json `settings.llm.*` (plus the gitignored
 * `mt.local.json` that mt.json imports) choose the backend; the default is the offline
 * `mock`, so the pipes and their tests run without credentials and without network.
 */

export const ROOT = resolve(import.meta.dirname, '..')

const logger = createConsoleLogger()

/** Free-tier suffix: only these ids cost nothing on OpenRouter. */
const FREE_MODEL_SUFFIX = ':free'

/** Env var that selects the model for one pipe (`MT_LLM_MODEL_<TOOL>`). */
export function modelEnvVar(tool: string): string {
  return `MT_LLM_MODEL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * Hard budget rule: every real backend must use a free OpenRouter id (`:free`).
 * `MT_ALLOW_PAID=1` is the deliberate paid-run escape hatch. `mock` is offline and exempt.
 */
export function assertFreeModel(backend: string, model: string, envHint = 'MT_LLM_MODEL'): void {
  if (backend === 'mock' || model.endsWith(FREE_MODEL_SUFFIX)) return
  if (process.env.MT_ALLOW_PAID === '1') return
  throw new Error(
    `refusing paid model '${model}' on backend '${backend}': free models only, the model id must end with '${FREE_MODEL_SUFFIX}'. Set ${envHint} (or MT_LLM_MODEL) to a free OpenRouter id, or MT_ALLOW_PAID=1 for a deliberate paid run.`,
  )
}

/**
 * A silent `mock` backend makes a whole book out of fake text while the run still exits 0 —
 * the worst failure for this sample, where two real runs are compared. Refuse it unless the
 * caller asked for offline output or this is the test suite (which relies on mock).
 */
export function assertRealBackend(tool: string, backend: string): void {
  if (backend !== 'mock') return
  if (process.env.MT_ALLOW_MOCK === '1') return
  if (process.env.VITEST) return
  throw new Error(
    `[${tool}] backend is 'mock': every stage would emit fake text and the run would still exit 0. Fix: set settings."llm.tool" in samples/sample2-practical/mt.local.json (e.g. "router" plus a ":free" llm.model.<stage> id), or set MT_ALLOW_MOCK=1 for a deliberate offline run.`,
  )
}

/** Per-tool model: `MT_LLM_MODEL_<TOOL>` env, else mt.json `settings["llm.model.<tool>"]`. */
function modelOverride(tool: string): string | undefined {
  const fromEnv = process.env[modelEnvVar(tool)]?.trim()
  if (fromEnv) return fromEnv
  const fromFile = readMtConfigSync(ROOT).settings?.[`llm.model.${tool}`]
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : undefined
}

/**
 * Tool-level LLM layer for tools that are LLM gates themselves (`createStatTranslateDict`)
 * and so cannot take `llm.schemaCall`. `undefined` for `mock` (use `.with({ call: mockLlmCall(..) })`).
 * Supports `ollama` and `router`; the endpoint still comes from MT_OLLAMA_URL / settings / vault.
 */
export function gateLayer(llm: LlmChoice): LlmConfigLayer | undefined {
  assertFreeModel(llm.tool, llm.model)
  const use = readLlmConfig(process.env, resolve(ROOT, 'mt.json')).use
  switch (llm.tool) {
    case 'mock':
      return undefined
    case 'ollama':
      return { provider: 'ollama', transport: 'fetch', model: llm.model, ...(use ? { use } : {}) }
    case 'router':
      return { provider: 'router', model: llm.model, ...(use ? { use } : {}) }
    default:
      throw new Error(
        `gateLayer: backend '${llm.tool}' is not supported here (use ollama | router | mock)`,
      )
  }
}

/**
 * Offline `mock` choice that never touches the gate: `settings.llm.use` (the `mt.local.json`
 * vault ref) is resolved inside the gate's `prepare` slot, so reusing the gate would fail on a
 * machine without that vault entry even when the backend is `mock`.
 */
function offlineChoice(model: string, source: MockSource): LlmChoice {
  const base = mockLlmChoice(source, model)
  const client = mockLlmClient(source)
  return {
    ...base,
    schemaCall: async (input) => {
      const messages = input.systemPrompt
        ? [{ role: 'system' as const, content: input.systemPrompt }, ...input.messages]
        : input.messages
      const response = await client.chatCompletion({ messages, model: input.model ?? model })
      return {
        content: response.content,
        model: response.model,
        tokens: response.usage.totalTokens,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        finishReason: response.finishReason,
      }
    },
  }
}

/**
 * The LLM backend for one pipe (`tool` = the pipe name, e.g. `summary`).
 * Logs the backend + model so the console shows what produced the output.
 */
export function pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']): LlmChoice {
  const model = modelOverride(tool)
  const config = readLlmConfig(process.env, resolve(ROOT, 'mt.json'))
  // `mock` must stay offline: `pickLlmTool` would still apply `settings.llm.use` (the
  // `mt.local.json` vault ref) and fail on a missing vault entry. Build the mock choice directly.
  if (config.tool === 'mock') {
    const llm = offlineChoice(model ?? 'mock', mockSource ?? ['mock'])
    assertFreeModel(llm.tool, llm.model, modelEnvVar(tool))
    assertRealBackend(tool, llm.tool)
    logger.info(`[${tool}] backend=${llm.tool} model=${llm.model}`)
    return llm
  }
  const llm = pickLlmTool({
    configPath: resolve(ROOT, 'mt.json'),
    ...(model ? { env: { ...process.env, MT_LLM_MODEL: model } } : {}),
    ...(mockSource ? { mockSource } : {}),
  })
  assertFreeModel(llm.tool, llm.model, modelEnvVar(tool))
  assertRealBackend(tool, llm.tool)
  logger.info(`[${tool}] backend=${llm.tool} model=${llm.model}`)
  return llm
}
