import { resolve } from 'node:path'
import { readMtConfigSync } from '@mt/core'
import {
  type LlmChoice,
  type LlmConfigLayer,
  type PickLlmToolOptions,
  pickLlmTool,
  readLlmConfig,
} from '@mt/tools'

// Single LLM config point of the sample: every pipeline picks its backend here.
// `MT_LLM_TOOL` / `MT_LLM_MODEL` or mt.json `settings.llm.*` (+ the gitignored mt.local.json
// it imports) choose the backend; the default is the offline `mock`.

export const ROOT = resolve(import.meta.dirname, '..')

/** Per-tool model: `MT_LLM_MODEL_<TOOL>` env, else mt.json `settings["llm.model.<tool>"]`. */
function modelOverride(tool: string): string | undefined {
  const envName = `MT_LLM_MODEL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv) return fromEnv
  const fromFile = readMtConfigSync(ROOT).settings?.[`llm.model.${tool}`]
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : undefined
}

/**
 * Tool-level LLM layer for tools that are LLM gates themselves (`createStatTranslateDict`) and
 * so cannot take `llm.schemaCall`. `undefined` for `mock` (use `.with({ call: mockLlmCall(..) })`).
 * Supports `ollama` and `router`; the endpoint still comes from MT_OLLAMA_URL / settings / vault.
 */
export function gateLayer(llm: LlmChoice): LlmConfigLayer | undefined {
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
 * The LLM backend for one pipeline (`tool` = the pipeline name, e.g. `summary`).
 * Logs the backend + model so the console shows what produced the output.
 */
export function pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']): LlmChoice {
  const model = modelOverride(tool)
  const llm = pickLlmTool({
    configPath: resolve(ROOT, 'mt.json'),
    ...(model ? { env: { ...process.env, MT_LLM_MODEL: model } } : {}),
    ...(mockSource ? { mockSource } : {}),
  })
  console.log(`[${tool}] backend=${llm.tool} model=${llm.model}`)
  return llm
}
