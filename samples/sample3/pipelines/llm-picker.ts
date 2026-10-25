/**
 * Single LLM config point of this sample.
 *
 * - `MT_LLM_TOOL` picks the backend: `router` | `openrouter-free` | `openrouter-pool` |
 *   `ollama` | `mock` (default `mock` - offline, no API key, no router).
 * - `MT_LLM_MODEL` picks the model (default: the backend's own model).
 * - `mt.json` -> `settings.llm.tool` / `settings.llm.model` are the file-based fallback;
 *   the env vars win over them.
 *
 * Everything the pipeline sends to an LLM (the optional typo-fix step) goes through the
 * returned {@link LlmChoice}.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineTool } from '@mt/core'
import type { ComposableTool, Tool, ToolContext } from '@mt/core'
import {
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type GateInput,
  type GateOutput,
  type GateSlot,
  type GateState,
  type MockSource,
  OLLAMA_MODEL,
  type SchemaDocLlmCall,
  llmGate,
  mockLlmCall,
  ollamaTool,
  openrouterFree,
  openrouterPool,
} from '@mt/tools'

/** Backends selectable with `MT_LLM_TOOL`. */
export const LLM_TOOLS = ['router', 'openrouter-free', 'openrouter-pool', 'ollama', 'mock'] as const

export type LlmTool = (typeof LLM_TOOLS)[number]

/** Model per backend, used when neither `MT_LLM_MODEL` nor mt.json sets one. */
const DEFAULT_MODELS: Record<LlmTool, string> = {
  router: 'openai/gpt-4o-mini',
  'openrouter-free': 'openrouter/free',
  'openrouter-pool': 'openrouter/free',
  ollama: OLLAMA_MODEL,
  mock: 'mock',
}

/** Effective LLM configuration (backend + model). */
export interface LlmConfig {
  /** Selected backend. */
  tool: LlmTool
  /** Model used by the selected backend. */
  model: string
}

/** The picked backend, wired for every LLM-backed tool of the sample. */
export interface LlmChoice {
  /** Selected backend (`MT_LLM_TOOL`). */
  tool: LlmTool
  /** Model in use (`MT_LLM_MODEL` or the backend default). */
  model: string
  /** The backend gate (slots `prepare -> fit -> call -> parse -> emit`). */
  gate: ComposableTool<GateInput, GateOutput, GateSlot>
  /** `call` backend for the schema-doc tools (summary / entities / schema). */
  schemaCall: SchemaDocLlmCall
}

export interface PickLlmToolOptions {
  /** Environment to read `MT_LLM_TOOL` / `MT_LLM_MODEL` from. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Scripted answers of the offline `mock` backend. */
  mockSource?: MockSource
  /** mt.json to read `settings.llm.*` from. Default: the mt.json next to the pipeline. */
  configPath?: string
}

/** mt.json of this sample (next to the pipeline). */
const MT_JSON = join(resolve(import.meta.dirname, '..'), 'mt.json')

/** `settings` of mt.json (empty when the file is missing or malformed). */
function readProjectSettings(configPath: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      settings?: Record<string, unknown>
    }
    return raw.settings ?? {}
  } catch {
    return {}
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function parseTool(value: string): LlmTool {
  const tool = value.trim().toLowerCase()
  if ((LLM_TOOLS as readonly string[]).includes(tool)) return tool as LlmTool
  throw new Error(
    `Unknown LLM tool '${value}' (MT_LLM_TOOL / settings.llm.tool). Valid: ${LLM_TOOLS.join(', ')}`,
  )
}

/**
 * Resolve the LLM configuration: env vars first, then mt.json `settings.llm.*`,
 * then the built-in defaults (`mock` backend, backend default model).
 */
export function readLlmConfig(
  env: Record<string, string | undefined> = process.env,
  configPath: string = MT_JSON,
): LlmConfig {
  const settings = readProjectSettings(configPath)
  const tool = parseTool(env.MT_LLM_TOOL ?? text(settings['llm.tool']) ?? 'mock')
  const model =
    env.MT_LLM_MODEL ??
    text(settings['llm.model']) ??
    (tool === 'ollama' ? env.MT_OLLAMA_MODEL : undefined) ??
    DEFAULT_MODELS[tool]
  return { tool, model }
}

/** The gate of the picked backend. `mock` swaps the `call` slot for a scripted answer. */
function gateFor(
  tool: LlmTool,
  mockSource: MockSource,
): ComposableTool<GateInput, GateOutput, GateSlot> {
  switch (tool) {
    case 'openrouter-free':
      return openrouterFree
    case 'openrouter-pool':
      return openrouterPool
    case 'ollama':
      return ollamaTool
    case 'mock':
      return llmGate.with({ call: mockLlmCall(mockSource) })
    default:
      return llmGate
  }
}

/** Pin the picked model on the gate input (the input layer wins over every other layer). */
function withModel(
  gate: ComposableTool<GateInput, GateOutput, GateSlot>,
  model: string,
): ComposableTool<GateInput, GateOutput, GateSlot> {
  const prepare = gate.slots.prepare as Tool<GateInput, GateState>
  const pinned = defineTool<GateInput, GateState>({
    name: `${gate.name}:prepare`,
    version: '1.0.0',
    mdDescription: `Pins the picked model (${model}) on the gate input.`,
    async invoke(env, ctx) {
      return prepare.invoke({ ...env, item: { ...env.item, model } }, ctx)
    },
  })
  return gate.with({ prepare: pinned })
}

/** Run one request through the picked gate and shape it like a chat completion. */
async function callGate(
  gate: ComposableTool<GateInput, GateOutput, GateSlot>,
  input: ChatCompletionInput,
  ctx: ToolContext,
): Promise<ChatCompletionOutput> {
  const res = await gate.invoke({ item: { ...input }, meta: {} }, ctx)
  const out = res.item
  return {
    content: out.content,
    model: out.model,
    tokens: out.tokens,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  }
}

/**
 * Pick the LLM backend and wire it for the LLM-backed tools of the sample.
 *
 * ```ts
 * const llm = pickLlmTool()
 * const reply = await llm.schemaCall({ messages: [...] }, ctx)
 * ```
 */
export function pickLlmTool(options: PickLlmToolOptions = {}): LlmChoice {
  const config = readLlmConfig(options.env ?? process.env, options.configPath ?? MT_JSON)
  const gate = withModel(gateFor(config.tool, options.mockSource ?? ['mock']), config.model)
  return {
    tool: config.tool,
    model: config.model,
    gate,
    schemaCall: (input, ctx) => callGate(gate, input, ctx),
  }
}
