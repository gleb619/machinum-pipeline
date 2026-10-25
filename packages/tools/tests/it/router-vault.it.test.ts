import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type LlmClient, createLlmClient } from '../../src/core/llm-client.js'
import { resolveLlmConfig } from '../../src/core/llm-config.js'
import {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  listOllamaModels,
  ollamaHealth,
} from '../../src/core/ollama-tool.js'

/**
 * GPU integration test, keyless path end to end: tools `router` provider -> in-process router
 * (loopback, ephemeral port, temp-dir vault) -> vault entry `provider: ollama` -> real ollama.
 * No API key anywhere. Run with `pnpm test:gpu`; excluded from `pnpm test`.
 *
 * Layering: `@mt/tools` has no dependency on `@mt/router`. The router is loaded by a relative
 * dynamic import of its standalone runtime, in this test file only (docs/steering/tools.md).
 * Unreachable ollama is a failure with a clear message, never a skip.
 */

interface RouterHandle {
  url: string
  close(): Promise<void>
}
type StartRouter = (options: Record<string, unknown>) => Promise<RouterHandle>

const ENTRY = 'gpu'
const TOKEN = 'it-router-token-0123456789'
const upstreamUrl = process.env.MT_OLLAMA_URL ?? OLLAMA_BASE_URL

const gateHint =
  'The ollama server (set MT_OLLAMA_URL to the GPU server) must be up to run `pnpm test:gpu`. ' +
  'Report this failure — do not skip the GPU gate and do not merge without it.'

async function loadStartRouter(): Promise<StartRouter> {
  const spec = '../../../router/server/standalone.ts'
  const mod = (await import(/* @vite-ignore */ spec)) as { startRouter: StartRouter }
  return mod.startRouter
}

let dir: string
let model: string
let startRouter: StartRouter
const handles: RouterHandle[] = []
const savedVault = process.env.MT_VAULT
const seen: string[] = []

async function boot(token?: string): Promise<RouterHandle> {
  const h = await startRouter({
    port: 0,
    host: '127.0.0.1',
    mock: false,
    vault: true,
    logDir: join(dir, token ? 'logs-token' : 'logs-open'),
    apiKeys: [],
    upstreams: [],
    token,
  })
  handles.push(h)
  return h
}

function clientFor(url: string, token?: string): LlmClient {
  const cfg = resolveLlmConfig({
    input: { provider: 'router', baseUrl: url, model: `${ENTRY}/${model}` },
    env: token ? { MT_ROUTER_TOKEN: token } : {},
  })
  // Retries off: a failing GPU gate must fail fast and visibly.
  return createLlmClient({ ...cfg, retry: { ...cfg.retry, max: 0 } }, undefined, { bare: true })
}

async function chat(client: LlmClient): Promise<string> {
  const res = await client.chatCompletion({
    model: `${ENTRY}/${model}`,
    messages: [{ role: 'user', content: 'Reply with exactly: GPU OK' }],
    temperature: 0,
    maxTokens: 16,
  })
  seen.push(JSON.stringify(res))
  expect(res.usage.completionTokens).toBeGreaterThan(0)
  return res.content
}

describe('router + vault GPU integration (keyless)', () => {
  beforeAll(async () => {
    const health = await ollamaHealth(upstreamUrl)
    if (!health.ok) {
      throw new Error(
        `GPU server unreachable at ${health.baseUrl} (default ${OLLAMA_BASE_URL}): ${health.error}. ${gateHint}`,
      )
    }
    // MT_OLLAMA_MODEL, else the project default if the server has it, else the first chat model.
    const names = (await listOllamaModels(upstreamUrl)).map((m) => m.name)
    model =
      process.env.MT_OLLAMA_MODEL ??
      (names.includes(OLLAMA_MODEL)
        ? OLLAMA_MODEL
        : names.find((n) => !/embed|bge|ocr/i.test(n))) ??
      ''
    if (!model)
      throw new Error(`No chat model on ${health.baseUrl}; set MT_OLLAMA_MODEL. ${gateHint}`)

    dir = await mkdtemp(join(tmpdir(), 'mt-router-it-'))
    const vault = join(dir, 'vault.json')
    await writeFile(
      vault,
      JSON.stringify({
        version: 1,
        entries: { [ENTRY]: { provider: 'ollama', baseUrl: upstreamUrl, models: [model] } },
      }),
    )
    process.env.MT_VAULT = vault
    startRouter = await loadStartRouter()
  }, 15_000)

  afterAll(async () => {
    for (const h of handles) await h.close()
    if (savedVault === undefined) {
      // biome-ignore lint/performance/noDelete: env var must be truly unset, not the string "undefined"
      delete process.env.MT_VAULT
    } else process.env.MT_VAULT = savedVault
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('open router: keyless chat via <entry>/<model>, model listed, no secrets leak', async () => {
    const h = await boot()
    const content = await chat(clientFor(h.url))
    expect(content.trim()).not.toBe('')

    const res = await fetch(`${h.url}/api/models`)
    const text = await res.text()
    seen.push(text)
    expect(res.status).toBe(200)
    const ids = (JSON.parse(text) as { data: Array<{ id: string }> }).data.map((m) => m.id)
    expect(ids).toContain(`${ENTRY}/${model}`)
  }, 30_000)

  it('token router: 401 without bearer, works with it, token never echoed', async () => {
    const h = await boot(TOKEN)

    const denied = await fetch(`${h.url}/api/models`)
    const deniedBody = await denied.text()
    seen.push(deniedBody)
    expect(denied.status).toBe(401)

    const noAuth = await fetch(`${h.url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${ENTRY}/${model}`,
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    seen.push(await noAuth.text())
    expect(noAuth.status).toBe(401)

    const content = await chat(clientFor(h.url, TOKEN))
    expect(content.trim()).not.toBe('')

    const ok = await fetch(`${h.url}/api/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const okText = await ok.text()
    seen.push(okText)
    expect(ok.status).toBe(200)
    expect((JSON.parse(okText) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain(
      `${ENTRY}/${model}`,
    )
  }, 30_000)

  it('responses and router log files contain no token', async () => {
    for (const body of seen) expect(body).not.toContain(TOKEN)
    for (const sub of ['logs-open', 'logs-token']) {
      const root = join(dir, sub)
      const files = await readdir(root).catch(() => [] as string[])
      for (const f of files) {
        const text = await readFile(join(root, f), 'utf8').catch(() => '')
        expect(text).not.toContain(TOKEN)
      }
    }
  })
})
