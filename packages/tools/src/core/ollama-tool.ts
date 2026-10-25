import type { LlmConfigLayer } from './llm-config.js'
import { type GateInput, type GateOutput, createLlmGate } from './llm-gate.js'

/**
 * Default endpoint: stock local ollama. Point `MT_OLLAMA_URL` at a remote GPU server
 * (e.g. `http://<gpu-host>:<port>/v1`). The OpenAI-compatible endpoint is `<host>:<port>/v1`,
 * the native API `<host>:<port>/api/...`.
 */
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1'

/** Default model (must exist on the server; override with `MT_OLLAMA_MODEL`). */
export const OLLAMA_MODEL = 'gemma4:latest'

/**
 * Tool-layer config of the `ollamaTool` gate: provider + transport only. The endpoint and the
 * model come from `MT_OLLAMA_URL` / `MT_OLLAMA_MODEL` (see `llm-config.ts`) or the preset
 * defaults below. `fetch` because the server needs no API key (the OpenAI SDK refuses to
 * construct without one).
 */
export const OLLAMA_LLM: LlmConfigLayer = {
  provider: 'ollama',
  transport: 'fetch',
}

/** Preset defaults: endpoint and model used when no layer above provides them. */
export const OLLAMA_DEFAULTS: LlmConfigLayer = {
  baseUrl: OLLAMA_BASE_URL,
  model: OLLAMA_MODEL,
}

/**
 * Ollama gate against an ollama server (local by default, remote via `MT_OLLAMA_URL`): thin preset over {@link createLlmGate}.
 *
 * Endpoint: `MT_OLLAMA_URL` (default {@link OLLAMA_BASE_URL}); model: `MT_OLLAMA_MODEL`
 * (default {@link OLLAMA_MODEL}). A per-call override still wins (`item.model` / `item.llm`).
 */
export const ollamaTool = createLlmGate<GateInput, GateOutput>({
  name: 'ollama',
  version: '1.0.0',
  mdDescription:
    'Ollama gate (provider ollama). ' +
    'Endpoint from MT_OLLAMA_URL (default http://localhost:11434/v1, e.g. a remote GPU server), model from MT_OLLAMA_MODEL (default gemma4:latest).',
  llm: OLLAMA_LLM,
  llmDefaults: OLLAMA_DEFAULTS,
  metaFlags: { ollama: true },
})

// ---------------------------------------------------------------------------
// Native API helpers (model list / health)
// ---------------------------------------------------------------------------

/** Injected `fetch` (tests) and request timeout. */
export interface OllamaRequestOptions {
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number
}

/** One entry of `GET /api/tags`. */
export interface OllamaModelInfo {
  name: string
  sizeBytes?: number
  digest?: string
  modifiedAt?: string
}

/** Result of {@link ollamaHealth}. */
export interface OllamaHealth {
  ok: boolean
  /** Native API root (no `/v1` suffix). */
  baseUrl: string
  version?: string
  error?: string
}

/** Native API root of an Ollama base URL: drops the OpenAI-compatible `/v1` suffix. */
export function ollamaApiRoot(baseUrl: string = OLLAMA_BASE_URL): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    const code =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : undefined
    return code ? `${err.message} (${code})` : err.message
  }
  return String(err)
}

async function ollamaGetJson(url: string, options: OllamaRequestOptions): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`ollama request failed: ${res.status} (${url})`)
  return res.json()
}

/**
 * Models available on the server (`GET /api/tags`). Throws when the server is unreachable.
 */
export async function listOllamaModels(
  baseUrl: string = OLLAMA_BASE_URL,
  options: OllamaRequestOptions = {},
): Promise<OllamaModelInfo[]> {
  const root = ollamaApiRoot(baseUrl)
  const data = (await ollamaGetJson(`${root}/api/tags`, options)) as {
    models?: Array<{
      name?: string
      model?: string
      size?: number
      digest?: string
      modified_at?: string
    }>
  }
  const models = data?.models ?? []
  return models
    .map((m) => ({
      name: m.name ?? m.model ?? '',
      ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
      ...(m.digest !== undefined ? { digest: m.digest } : {}),
      ...(m.modified_at !== undefined ? { modifiedAt: m.modified_at } : {}),
    }))
    .filter((m) => m.name !== '')
}

/**
 * Health check (`GET /api/version`): never throws, reports `ok: false` with the error message
 * when the server is unreachable (e.g. `ECONNREFUSED`).
 */
export async function ollamaHealth(
  baseUrl: string = OLLAMA_BASE_URL,
  options: OllamaRequestOptions = {},
): Promise<OllamaHealth> {
  const root = ollamaApiRoot(baseUrl)
  try {
    const data = (await ollamaGetJson(`${root}/api/version`, options)) as { version?: string }
    return {
      ok: true,
      baseUrl: root,
      ...(data?.version !== undefined ? { version: data.version } : {}),
    }
  } catch (err) {
    return { ok: false, baseUrl: root, error: errorMessage(err) }
  }
}
