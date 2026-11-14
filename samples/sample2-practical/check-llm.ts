import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type ToolContext, loadVault, readMtConfigSync } from '@mt/core'
import {
  DEFAULT_ROUTER_URL,
  OLLAMA_BASE_URL,
  listOllamaModels,
  ollamaHealth,
  readLlmConfig,
  resolveLlmConfigFromCtx,
} from '@mt/tools'
import { assertFreeModel, modelEnvVar } from './lib/llm.js'

/**
 * Prints which backend/model the practical pipes will use. For `ollama` it also checks that the
 * server answers and that the configured model is installed; for `router` it answers "can I run
 * the stages on free models right now?" by listing the free ids and probing every configured
 * stage model with a real completion.
 *
 *   pnpm run check-llm
 *
 * A key is never printed; the vault is read through `@mt/core` (`loadVault`), never by hand.
 */
const ROOT = import.meta.dirname
const STAGES = ['summary', 'ner', 'preprocess', 'translate'] as const
const FREE_SUFFIX = ':free'
// Thinking models fill `reasoning` before `content`; 512 tokens routinely truncates before any
// content appears, which the probe would report as a false FAIL.
const PROBE_MAX_TOKENS = 2048
const PROBE_TIMEOUT_MS = 120_000

const config = readLlmConfig(process.env, resolve(ROOT, 'mt.json'))
const settings = readMtConfigSync(ROOT).settings ?? {}
console.log(`backend: ${config.tool}`)
console.log(`model:   ${config.model}`)

if (config.tool === 'mock') {
  console.log(
    'backend mock is offline: nothing to probe (set MT_LLM_TOOL=router to check free models).',
  )
  process.exit(0)
}

if (config.tool === 'ollama') {
  const url = process.env.MT_OLLAMA_URL ?? String(settings['llm.baseUrl'] ?? OLLAMA_BASE_URL)
  console.log(`url:     ${url}`)
  const health = await ollamaHealth(url)
  if (!health.ok) {
    console.error(`server not reachable: ${health.error} (SSH tunnel up? URL right?)`)
    process.exit(1)
  }
  console.log(`server:  ollama ${health.version ?? '?'}`)
  const names = (await listOllamaModels(url)).map((model) => model.name)
  console.log(`models:  ${names.join(', ') || '(none)'}`)
  if (!names.includes(config.model)) {
    console.error(`model '${config.model}' is not on the server (ollama pull ${config.model})`)
    process.exit(1)
  }
  console.log('ok')
  process.exit(0)
}

interface ProbeResult {
  ok: boolean
  status: number
  latencyMs: number
  contentChars: number
  reasoningChars: number
  reason?: string
}

const vaultRoot = findVaultRoot(ROOT)
const vault = await loadVault(vaultRoot, process.env)
console.log(`vault:   resolved (${Object.keys(vault.entries).length} entries)`)

const ctx = {
  run: { global: { settings, env: {}, vault, project: { root: ROOT } } },
} as unknown as ToolContext

await reportFreeIds()

const probes = new Map<string, Promise<ProbeResult>>()
let failed = false
for (const stage of STAGES) {
  const model = stageModel(stage)
  try {
    assertFreeModel(config.tool, model, modelEnvVar(stage))
  } catch (err) {
    failed = true
    console.log(row(stage, model, 0, 0, 0, 0, false, messageOf(err)))
    continue
  }
  let probe = probes.get(model)
  if (!probe) {
    probe = probeModel(ctx, model, config.use)
    probes.set(model, probe)
  }
  const result = await probe
  if (!result.ok) failed = true
  console.log(
    row(
      stage,
      model,
      result.status,
      result.latencyMs,
      result.contentChars,
      result.reasoningChars,
      result.ok,
      result.reason,
    ),
  )
}

console.log(
  failed
    ? 'RESULT: FAIL - at least one configured stage model did not answer'
    : 'RESULT: PASS - every configured stage model answered on free ids',
)
process.exit(failed ? 1 : 0)

/** Stage model: `MT_LLM_MODEL_<STAGE>` -> `settings["llm.model.<stage>"]` -> resolved fallback. */
function stageModel(stage: string): string {
  const fromEnv = process.env[modelEnvVar(stage)]?.trim()
  if (fromEnv) return fromEnv
  const fromFile = settings[`llm.model.${stage}`]
  if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim()
  return config.model
}

/** The nearest ancestor holding the project vault (`MT_VAULT` / `MT_HOME` still win). */
function findVaultRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.mt', 'vault.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * Where to list model ids. The run does not necessarily use the local router: a vault ref
 * (`MT_LLM_USE=vault://openrouter-loop/...`) resolves `baseUrl` to OpenRouter directly, so list
 * from the same endpoint `probeModel` resolves. Fall back to `MT_ROUTER_URL` only when the
 * config resolves no endpoint of its own (provider-default local router).
 */
function modelListTarget(): { label: string; baseUrl: string; path: string; apiKey?: string } {
  try {
    const resolved = resolveLlmConfigFromCtx(ctx, {
      input: { model: config.model, ...(config.use ? { use: config.use } : {}) },
    })
    const routerDefault =
      resolved.provider === 'router' &&
      (resolved.sources.baseUrl === 'default' ||
        resolved.sources.baseUrl === 'env' ||
        resolved.sources.baseUrl === 'ctx.routerUrl')
    if (!routerDefault) {
      return {
        label: resolved.provider,
        baseUrl: resolved.baseUrl,
        path: resolved.provider === 'openrouter' ? '/models' : '/api/models',
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      }
    }
  } catch {
    // no vault ref / settings baseUrl — fall through to MT_ROUTER_URL
  }
  return {
    label: 'router',
    baseUrl: process.env.MT_ROUTER_URL ?? DEFAULT_ROUTER_URL,
    path: '/api/models',
  }
}

async function reportFreeIds(): Promise<void> {
  const target = modelListTarget()
  try {
    const ids = await listModelIds(
      `${target.baseUrl.replace(/\/+$/, '')}${target.path}`,
      target.apiKey,
    )
    const free = ids.filter((id) => id.endsWith(FREE_SUFFIX))
    console.log(`${target.label}: ${target.baseUrl} (${ids.length} ids, ${free.length} free)`)
    if (free.length > 0) console.log(`free:    ${free.join(', ')}`)
  } catch (err) {
    console.log(
      `${target.label}: ${target.baseUrl} unreachable (${messageOf(err)}); free checked by id suffix`,
    )
  }
}

async function listModelIds(url: string, apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
  return (body.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

async function probeModel(ctx: ToolContext, model: string, use?: string): Promise<ProbeResult> {
  const started = Date.now()
  let resolved: ReturnType<typeof resolveLlmConfigFromCtx>
  try {
    resolved = resolveLlmConfigFromCtx(ctx, { input: { model, ...(use ? { use } : {}) } })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      contentChars: 0,
      reasoningChars: 0,
      reason: messageOf(err),
    }
  }
  const url = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
        max_tokens: PROBE_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - started
    const text = await res.text()
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        contentChars: 0,
        reasoningChars: 0,
        reason: `HTTP ${res.status}: ${firstLine(text)}`,
      }
    }
    const message = completionMessage(text)
    const content = message.content.trim()
    const reasoningChars = message.reasoning.trim().length
    if (content === '') {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        contentChars: 0,
        reasoningChars,
        reason: reasoningChars > 0 ? 'content empty, reasoning only' : 'content empty',
      }
    }
    return {
      ok: true,
      status: res.status,
      latencyMs,
      contentChars: content.length,
      reasoningChars,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      contentChars: 0,
      reasoningChars: 0,
      reason: messageOf(err),
    }
  }
}

function completionMessage(text: string): { content: string; reasoning: string } {
  try {
    const body = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>
    }
    const message = body.choices?.[0]?.message
    return {
      content: typeof message?.content === 'string' ? message.content : '',
      reasoning: typeof message?.reasoning === 'string' ? message.reasoning : '',
    }
  } catch {
    return { content: '', reasoning: '' }
  }
}

function row(
  stage: string,
  model: string,
  status: number,
  latencyMs: number,
  contentChars: number,
  reasoningChars: number,
  ok: boolean,
  reason?: string,
): string {
  const free = model.endsWith(FREE_SUFFIX) ? 'yes' : 'no'
  const verdict = ok ? 'PASS' : `FAIL ${reason ?? ''}`.trim()
  return `stage=${stage} model=${model} free=${free} status=${status} latencyMs=${latencyMs} contentChars=${contentChars} reasoningChars=${reasoningChars} ${verdict}`
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').slice(0, 160)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
