import type { LlmConfigLayer } from './llm-config.js'
import { type GateInput, type GateOutput, createLlmGate } from './llm-gate.js'

/**
 * Tool-layer LLM config of the `openrouterFree` gate: direct OpenRouter (not the MT router proxy),
 * free model. Keys come from the existing `llm-config` resolution (`OPENROUTER_API_KEYS` pool,
 * then `OPENROUTER_API_KEY`); `baseUrl` defaults to the public OpenRouter endpoint.
 */
export const OPENROUTER_FREE_LLM: LlmConfigLayer = {
  provider: 'openrouter',
  model: 'openrouter/free',
}

/**
 * Free-tier OpenRouter gate: thin preset over {@link createLlmGate} with {@link OPENROUTER_FREE_LLM}
 * as the tool-level config layer. Slots are the standard `prepare -> fit -> call -> parse -> emit`,
 * so anything stays swappable (`openrouterFree.with({ call: mockLlmCall(['ok']) })` — offline tests).
 *
 * A per-call override still wins (`item.model` / `item.llm`); the preset sits on the tool layer,
 * above `meta.llm`, settings and env.
 */
export const openrouterFree = createLlmGate<GateInput, GateOutput>({
  name: 'openrouter-free',
  version: '1.0.0',
  mdDescription:
    'OpenRouter free-tier gate (provider openrouter, model openrouter/free). ' +
    'Keys from OPENROUTER_API_KEYS / OPENROUTER_API_KEY; per-call model override wins.',
  llm: OPENROUTER_FREE_LLM,
  metaFlags: { openrouterFree: true },
})
