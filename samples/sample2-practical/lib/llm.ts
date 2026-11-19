import { dirname, resolve } from 'node:path'
import { createConsoleLogger, readMtConfigSync } from '@mt/core'
import type { Logger } from '@mt/core'
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
 * The single LLM config point of the sample.
 *
 * The mechanism (`pickLlmTool` / `readLlmConfig` / `mockLlmChoice`) lives in `@mt/tools`; this
 * file owns the sample policy: free OpenRouter ids unless `MT_ALLOW_PAID=1`, and a real backend
 * unless `MT_ALLOW_MOCK=1`.
 */

export const ROOT = resolve(import.meta.dirname, '..')

/** The sample `mt.json` (with its `mt.local.json` imports) every LLM check reads. */
export const llmConfigPath = resolve(ROOT, 'mt.json')

export interface BookLlmGuardOptions {
  /** Refuse non-`:free` models on real backends. Default false. */
  freeOnly?: boolean
  /** Refuse the offline `mock` backend. Default false. */
  requireRealBackend?: boolean
  /** Free-tier suffix. Default `:free`. */
  freeModelSuffix?: string
  /** Env var that allows a paid model when set to `1`. Default `MT_ALLOW_PAID`. */
  allowPaidEnv?: string
  /** Env var that allows `mock` when set to `1`. Default `MT_ALLOW_MOCK`. */
  allowMockEnv?: string
  /** Env used by the standalone guard helpers. Default `process.env`. */
  env?: Record<string, string | undefined>
}

export interface BookLlmPickerOptions {
  root: string
  configPath?: string
  env?: Record<string, string | undefined>
  logger?: Logger
  guard?: BookLlmGuardOptions
}

export interface BookLlmPicker {
  pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']): LlmChoice
  gateLayer(llm: LlmChoice): LlmConfigLayer | undefined
  modelEnvVar(tool: string): string
}

const DEFAULT_FREE_MODEL_SUFFIX = ':free'
const DEFAULT_ALLOW_PAID_ENV = 'MT_ALLOW_PAID'
const DEFAULT_ALLOW_MOCK_ENV = 'MT_ALLOW_MOCK'

/** Env var that selects the model for one pipe (`MT_LLM_MODEL_<TOOL>`). */
export function modelEnvVar(tool: string): string {
  return `MT_LLM_MODEL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

function policyEnv(policy: BookLlmGuardOptions): Record<string, string | undefined> {
  return policy.env ?? process.env
}

/**
 * Hard budget rule when `freeOnly` is on: every real backend must use a free model id.
 * `allowPaidEnv=1` is the deliberate paid-run escape hatch. `mock` is offline and exempt.
 */
export function assertFreeModel(
  backend: string,
  model: string,
  envHint = 'MT_LLM_MODEL',
  policy: BookLlmGuardOptions = {},
): void {
  if (!policy.freeOnly) return
  const suffix = policy.freeModelSuffix ?? DEFAULT_FREE_MODEL_SUFFIX
  if (backend === 'mock' || model.endsWith(suffix)) return
  const allowEnv = policy.allowPaidEnv ?? DEFAULT_ALLOW_PAID_ENV
  if (policyEnv(policy)[allowEnv] === '1') return
  throw new Error(
    `refusing paid model '${model}' on backend '${backend}': free models only, the model id must end with '${suffix}'. Set ${envHint} (or MT_LLM_MODEL) to a free OpenRouter id, or ${allowEnv}=1 for a deliberate paid run.`,
  )
}

/**
 * A silent `mock` backend makes a whole book out of fake text while the run still exits 0.
 * When `requireRealBackend` is on, refuse it unless `allowMockEnv=1` (or the Vitest marker is
 * present, matching the sample's test behavior).
 */
export function assertRealBackend(
  tool: string,
  backend: string,
  policy: BookLlmGuardOptions = {},
): void {
  if (!policy.requireRealBackend || backend !== 'mock') return
  const env = policyEnv(policy)
  const allowEnv = policy.allowMockEnv ?? DEFAULT_ALLOW_MOCK_ENV
  if (env[allowEnv] === '1' || env.VITEST) return
  throw new Error(
    `[${tool}] backend is 'mock': every stage would emit fake text and the run would still exit 0. Fix: set settings."llm.tool" in the project's mt.json / mt.local.json (e.g. "router" plus a ':free' llm.model.<stage> id), or set ${allowEnv}=1 for a deliberate offline run.`,
  )
}

/**
 * Offline `mock` choice that never touches the gate: `settings.llm.use` (the vault ref) is
 * resolved inside the gate's `prepare` slot, so reusing the gate would fail on a machine
 * without that vault entry even when the backend is `mock`.
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

export function createBookLlmPicker(options: BookLlmPickerOptions): BookLlmPicker {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? join(options.root, 'mt.json')
  const configRoot = dirname(configPath)
  const logger = options.logger ?? createConsoleLogger()
  const guard = options.guard ?? {}

  /** Per-tool model: `MT_LLM_MODEL_<TOOL>` env, else mt.json `settings["llm.model.<tool>"]`. */
  function modelOverride(tool: string): string | undefined {
    const fromEnv = env[modelEnvVar(tool)]?.trim()
    if (fromEnv) return fromEnv
    const fromFile = readMtConfigSync(configRoot).settings?.[`llm.model.${tool}`]
    return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : undefined
  }

  /** Tool-level LLM layer for tools that are LLM gates themselves. */
  function gateLayer(llm: LlmChoice): LlmConfigLayer | undefined {
    assertFreeModel(llm.tool, llm.model, modelEnvVar(llm.tool), guard)
    const use = readLlmConfig(env, configPath).use
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

  function pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']): LlmChoice {
    const model = modelOverride(tool)
    const config = readLlmConfig(env, configPath)
    // `mock` must stay offline: `pickLlmTool` would still apply `settings.llm.use` (the
    // vault ref) and fail on a missing vault entry. Build the mock choice directly.
    if (config.tool === 'mock') {
      const llm = offlineChoice(model ?? 'mock', mockSource ?? ['mock'])
      assertFreeModel(llm.tool, llm.model, modelEnvVar(tool), guard)
      assertRealBackend(tool, llm.tool, guard)
      logger.info(`[${tool}] backend=${llm.tool} model=${llm.model}`)
      return llm
    }
    const llm = pickLlmTool({
      configPath,
      env: model ? { ...env, MT_LLM_MODEL: model } : env,
      ...(mockSource ? { mockSource } : {}),
    })
    assertFreeModel(llm.tool, llm.model, modelEnvVar(tool), guard)
    assertRealBackend(tool, llm.tool, guard)
    logger.info(`[${tool}] backend=${llm.tool} model=${llm.model}`)
    return llm
  }

  return {
    pickFor,
    gateLayer,
    modelEnvVar,
  }
}

const picker = createBookLlmPicker({
  root: ROOT,
  configPath: llmConfigPath,
  logger: createConsoleLogger(),
  guard: { freeOnly: true, requireRealBackend: true },
})

export const { gateLayer } = picker

/** Cheap config-only check; it resolves no backend and logs nothing. */
export function usesMockBackend(): boolean {
  return readLlmConfig(process.env, llmConfigPath).tool === 'mock'
}

/** The LLM backend for one pipe (`tool` = the pipe name, e.g. `summary`). */
export function pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']) {
  return picker.pickFor(tool, mockSource)
}
