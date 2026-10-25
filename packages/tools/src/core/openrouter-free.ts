import type { LlmConfigLayer } from './llm-config.js'
import { type GateInput, type GateOutput, createLlmGate } from './llm-gate.js'

/**
 * Tool-layer LLM config of the `openrouterFree` gate: pins the **provider** only (`openrouter`,
 * direct — not the MT router proxy). Keys come from the existing `llm-config` resolution
 * (`OPENROUTER_API_KEYS` pool, then `OPENROUTER_API_KEY`); `baseUrl` defaults to the public
 * OpenRouter endpoint. The model is *not* here: see {@link OPENROUTER_FREE_DEFAULTS}.
 */
export const OPENROUTER_FREE_LLM: LlmConfigLayer = {
  provider: 'openrouter',
}

/**
 * Preset default model: a default, not a pin, so a per-call `model` / `llm.model`, `meta.llm.model`,
 * vault ref (`llm.use`) or mt.json `llm.model` chooses another model. Only the provider is pinned.
 */
export const OPENROUTER_FREE_DEFAULTS: LlmConfigLayer = {
  model: 'openrouter/free',
}

/**
 * Free-tier OpenRouter gate: thin preset over {@link createLlmGate} with {@link OPENROUTER_FREE_LLM}
 * as the tool-level config layer (provider pin) and {@link OPENROUTER_FREE_DEFAULTS} as preset
 * defaults. Slots are the standard `prepare -> fit -> call -> parse -> emit`, so anything stays
 * swappable (`openrouterFree.with({ call: mockLlmCall(['ok']) })` — offline tests).
 *
 * `openrouter/free` is a default, never a pin: any layer above the preset defaults wins
 * (call input > tool > `meta.llm` > settings > vault > provider env). The provider pin sits on the
 * tool layer; a vault entry of another provider (`llm.use`) is an error, same provider is fine.
 */
export const openrouterFree = createLlmGate<GateInput, GateOutput>({
  name: 'openrouter-free',
  version: '1.0.0',
  mdDescription:
    'OpenRouter free-tier gate (provider openrouter; model openrouter/free as a default, overridable by ' +
    'per-call / meta / settings / vault). Keys from OPENROUTER_API_KEYS / OPENROUTER_API_KEY.',
  llm: OPENROUTER_FREE_LLM,
  llmDefaults: OPENROUTER_FREE_DEFAULTS,
  metaFlags: { openrouterFree: true },
})
