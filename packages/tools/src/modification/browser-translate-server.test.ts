import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type BrowserTranslateServer,
  parseBrowserTranslateServerArgs,
  startBrowserTranslateServer,
} from './browser-translate-server.js'
import type { BrowserTranslateEngine } from './browser-translate.js'

interface EngineInput {
  text: string
  sourceLang?: string
  targetLang: string
}

interface TestEngine extends BrowserTranslateEngine {
  calls: EngineInput[]
  readonly closeCount: number
}

interface TranslateResult {
  translatedText: string
  engine: string
  model: string
  ms: number
  cached: boolean
}

interface HealthResult {
  status: string
  engine: string
  cache: { entries: number; bytes: number; hits: number; misses: number }
  active: number
  queued: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve: (value: T) => resolve(value) }
}

function makeEngine(translate: (input: EngineInput) => string | Promise<string>): TestEngine {
  const calls: EngineInput[] = []
  let closeCount = 0
  return {
    calls,
    get closeCount() {
      return closeCount
    },
    async translate(input) {
      calls.push({ ...input })
      return translate(input)
    },
    async close() {
      closeCount++
    },
  }
}

async function start(
  engine: BrowserTranslateEngine,
  options: Partial<Parameters<typeof startBrowserTranslateServer>[0]> = {},
): Promise<BrowserTranslateServer> {
  return startBrowserTranslateServer({ port: 0, engine, ...options })
}

async function postTranslate(
  server: BrowserTranslateServer,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(`${server.url}/translate`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface RawResponse {
  status: number
  raw: string
}

function rawPost(url: string, headers: Record<string, string>, body = ''): Promise<RawResponse> {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) })
    let raw = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('rawPost timed out'))
    }, 2000)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const lines = [
        'POST /translate HTTP/1.1',
        `Host: ${parsed.host}`,
        'Connection: close',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n') + body)
    })
    socket.on('data', (chunk) => {
      raw += chunk
    })
    socket.on('end', () => {
      clearTimeout(timer)
      const match = /^HTTP\/1\.1 (\d+)/.exec(raw)
      resolve({ status: match ? Number(match[1]) : 0, raw })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function startPartialUpload(url: string, declaredLength: number): Promise<Socket> {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) })
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          'POST /translate HTTP/1.1',
          `Host: ${parsed.host}`,
          'Content-Type: application/json',
          `Content-Length: ${declaredLength}`,
          '',
          '{"text":',
        ].join('\r\n'),
      )
      resolve(socket)
    })
  })
}

async function withCleanTokenEnv<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.MT_BROWSER_TRANSLATE_TOKEN
  Reflect.deleteProperty(process.env, 'MT_BROWSER_TRANSLATE_TOKEN')
  try {
    return await run()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'MT_BROWSER_TRANSLATE_TOKEN')
    else process.env.MT_BROWSER_TRANSLATE_TOKEN = previous
  }
}

describe('browser-translate server', () => {
  it('serves health without auth', async () => {
    const engine = makeEngine(({ text }) => `translated:${text}`)
    const server = await start(engine, { token: 'secret' })
    try {
      const response = await fetch(`${server.url}/health`)
      expect(response.status).toBe(200)
      const health = await readJson<HealthResult>(response)
      expect(health).toMatchObject({
        status: 'ok',
        engine: 'google-endpoint',
        cache: { entries: 0, bytes: 0, hits: 0, misses: 0 },
        active: 0,
        queued: 0,
      })
    } finally {
      await server.close()
    }
  })

  it('requires the bearer token when configured', async () => {
    const engine = makeEngine(({ text }) => `translated:${text}`)
    const server = await start(engine, { token: 'secret' })
    try {
      const body = { text: 'Hello', targetLang: 'es' }

      const missing = await postTranslate(server, body)
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toBe('Bearer')

      const wrong = await postTranslate(server, body, 'wrong')
      expect(wrong.status).toBe(401)

      const accepted = await postTranslate(server, body, 'secret')
      expect(accepted.status).toBe(200)
      const result = await readJson<TranslateResult>(accepted)
      expect(result.translatedText).toBe('translated:Hello')
      expect(result.cached).toBe(false)
      expect(engine.calls).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('translates without auth when no token is configured', async () => {
    const engine = makeEngine(({ text, sourceLang, targetLang }) => {
      return `${sourceLang}:${targetLang}:${text}`
    })
    const server = await start(engine)
    try {
      const response = await postTranslate(server, {
        text: 'Hello',
        sourceLang: 'en',
        targetLang: 'de',
      })
      expect(response.status).toBe(200)
      const result = await readJson<TranslateResult>(response)
      expect(result.translatedText).toBe('en:de:Hello')
      expect(engine.calls).toEqual([{ text: 'Hello', sourceLang: 'en', targetLang: 'de' }])
    } finally {
      await server.close()
    }
  })

  it('rejects invalid JSON and invalid bodies with 400', async () => {
    const engine = makeEngine(() => 'never')
    const server = await start(engine)
    try {
      const malformed = await fetch(`${server.url}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
      expect(malformed.status).toBe(400)

      const missingText = await postTranslate(server, { targetLang: 'es' })
      expect(missingText.status).toBe(400)

      const missingTarget = await postTranslate(server, { text: 'Hello' })
      expect(missingTarget.status).toBe(400)

      const badCache = await postTranslate(server, {
        text: 'Hello',
        targetLang: 'es',
        cache: 'yes',
      })
      expect(badCache.status).toBe(400)
      expect(engine.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('rejects bodies over 10 MiB with 413', async () => {
    const engine = makeEngine(() => 'never')
    const server = await start(engine)
    try {
      const response = await postTranslate(server, {
        text: 'x'.repeat(10 * 1024 * 1024),
        targetLang: 'es',
      })
      expect(response.status).toBe(413)
      expect(engine.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    const engine = makeEngine(() => 'never')
    const server = await start(engine)
    try {
      const response = await rawPost(`${server.url}/translate`, {
        'Content-Type': 'application/json',
        'Content-Length': String(10 * 1024 * 1024 + 1),
      })

      expect(response.status).toBe(413)
      expect(response.raw.toLowerCase()).toContain('connection: close')
      expect(engine.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('bounds concurrent uploads and returns 429 past the bound', async () => {
    const engine = makeEngine(() => 'never')
    const server = await start(engine, { concurrency: 1, queueLimit: 0 })
    let held: Socket | undefined
    try {
      held = await startPartialUpload(`${server.url}/translate`, 100)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const body = JSON.stringify({ text: 'second', targetLang: 'es' })
      const response = await rawPost(
        `${server.url}/translate`,
        {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        body,
      )

      expect(response.status).toBe(429)
      expect(response.raw.toLowerCase()).toContain('retry-after: 1')
      expect(engine.calls).toHaveLength(0)
    } finally {
      held?.destroy()
      await server.close()
    }
  })

  it('caches by source, target, and text; cache:false bypasses lookup but stores', async () => {
    const engine = makeEngine(({ text }) => `translated:${text}`)
    const server = await start(engine)
    try {
      const body = { text: 'Hello', sourceLang: 'en', targetLang: 'es' }

      const first = await postTranslate(server, body)
      const firstResult = await readJson<TranslateResult>(first)
      expect(firstResult.cached).toBe(false)
      expect(engine.calls).toHaveLength(1)

      const second = await postTranslate(server, body)
      const secondResult = await readJson<TranslateResult>(second)
      expect(secondResult.cached).toBe(true)
      expect(secondResult.translatedText).toBe('translated:Hello')
      expect(engine.calls).toHaveLength(1)

      const bypass = await postTranslate(server, { ...body, cache: false })
      const bypassResult = await readJson<TranslateResult>(bypass)
      expect(bypassResult.cached).toBe(false)
      expect(engine.calls).toHaveLength(2)

      const storedAgain = await postTranslate(server, body)
      const storedAgainResult = await readJson<TranslateResult>(storedAgain)
      expect(storedAgainResult.cached).toBe(true)
      expect(engine.calls).toHaveLength(2)

      const health = await readJson<HealthResult>(await fetch(`${server.url}/health`))
      expect(health.cache.entries).toBe(1)
      expect(health.cache.bytes).toBeGreaterThan(0)
      expect(health.cache.hits).toBe(2)
      expect(health.cache.misses).toBe(2)
      expect(health.active).toBe(0)
      expect(health.queued).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('does not cache empty translations', async () => {
    let calls = 0
    const engine = makeEngine(() => {
      calls++
      return calls === 1 ? '' : 'hola'
    })
    const server = await start(engine)
    try {
      const body = { text: 'Hello', targetLang: 'es' }

      const first = await postTranslate(server, body)
      expect(first.status).toBe(502)
      expect(await first.text()).toContain('Translation returned empty text')

      const second = await postTranslate(server, body)
      expect(second.status).toBe(200)
      const result = await readJson<TranslateResult>(second)
      expect(result.translatedText).toBe('hola')
      expect(result.cached).toBe(false)
      expect(calls).toBe(2)

      const health = await readJson<HealthResult>(await fetch(`${server.url}/health`))
      expect(health.cache.entries).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('evicts by cache byte size', async () => {
    const value = 'x'.repeat(50)
    const engine = makeEngine(() => value)
    const server = await start(engine, { cacheEntries: 10, cacheMaxBytes: 100 })
    try {
      const first = await postTranslate(server, { text: 'first', targetLang: 'es' })
      expect(first.status).toBe(200)

      const second = await postTranslate(server, { text: 'second', targetLang: 'es' })
      expect(second.status).toBe(200)

      const health = await readJson<HealthResult>(await fetch(`${server.url}/health`))
      expect(health.cache.entries).toBe(1)
      expect(health.cache.bytes).toBeLessThanOrEqual(100)

      await postTranslate(server, { text: 'first', targetLang: 'es' })
      expect(engine.calls).toHaveLength(3)
    } finally {
      await server.close()
    }
  })

  it('skips caching a single entry larger than the byte cap', async () => {
    const engine = makeEngine(() => 'x'.repeat(50))
    const server = await start(engine, { cacheMaxBytes: 20 })
    try {
      const body = { text: 'Hello', targetLang: 'es' }
      expect((await postTranslate(server, body)).status).toBe(200)
      expect((await postTranslate(server, body)).status).toBe(200)
      expect(engine.calls).toHaveLength(2)

      const health = await readJson<HealthResult>(await fetch(`${server.url}/health`))
      expect(health.cache).toMatchObject({ entries: 0, bytes: 0 })
    } finally {
      await server.close()
    }
  })

  it('does not collide cache keys when language fields contain NUL', async () => {
    const engine = makeEngine(({ sourceLang, targetLang, text }) => {
      return `${sourceLang}|${targetLang}|${text}`
    })
    const server = await start(engine)
    try {
      const first = await postTranslate(server, {
        text: 'same',
        sourceLang: 'a\0b',
        targetLang: 'c',
      })
      const second = await postTranslate(server, {
        text: 'same',
        sourceLang: 'a',
        targetLang: 'b\0c',
      })

      expect((await readJson<TranslateResult>(first)).translatedText).toBe('a\0b|c|same')
      expect((await readJson<TranslateResult>(second)).translatedText).toBe('a|b\0c|same')
      expect(engine.calls).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('bounds concurrency and returns 429 when the queue is full', async () => {
    const gates = [deferred<string>(), deferred<string>()]
    const started = [deferred<void>(), deferred<void>()]
    let call = 0
    const engine = makeEngine(async () => {
      const index = call
      call++
      const gate = gates[index]
      const start = started[index]
      if (!gate || !start) throw new Error('unexpected engine call')
      start.resolve(undefined)
      return gate.promise
    })
    const server = await start(engine, { concurrency: 1, queueLimit: 1 })
    let first: Promise<Response> | undefined
    let second: Promise<Response> | undefined
    try {
      first = postTranslate(server, { text: 'one', targetLang: 'es' })
      await started[0]?.promise

      second = postTranslate(server, { text: 'two', targetLang: 'es' })
      await waitFor(() => server.stats.queued === 1)

      const third = await postTranslate(server, { text: 'three', targetLang: 'es' })
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).toBe('1')

      gates[0]?.resolve('uno')
      await started[1]?.promise
      gates[1]?.resolve('dos')

      const responses = await Promise.all([first, second])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect((await readJson<TranslateResult>(responses[0] as Response)).translatedText).toBe('uno')
      expect((await readJson<TranslateResult>(responses[1] as Response)).translatedText).toBe('dos')
      expect(server.stats.active).toBe(0)
      expect(server.stats.queued).toBe(0)
    } finally {
      gates[0]?.resolve('cleanup')
      gates[1]?.resolve('cleanup')
      await Promise.allSettled([first, second].filter((item) => item !== undefined))
      await server.close()
    }
  })

  it('maps engine errors to 502 and timeouts to 504', async () => {
    const engine = makeEngine(({ text }) => {
      if (text === 'timeout') {
        const error = new Error('slow translation')
        error.name = 'TimeoutError'
        throw error
      }
      throw new Error('engine boom')
    })
    const server = await start(engine)
    try {
      const failed = await postTranslate(server, { text: 'fail', targetLang: 'es' })
      expect(failed.status).toBe(502)
      expect(await failed.text()).toContain('engine boom')

      const timedOut = await postTranslate(server, { text: 'timeout', targetLang: 'es' })
      expect(timedOut.status).toBe(504)
      expect(await timedOut.text()).toContain('slow translation')
    } finally {
      await server.close()
    }
  })

  it('close waits for in-flight work and leaves an injected engine open', async () => {
    const gate = deferred<string>()
    const started = deferred<void>()
    const engine = makeEngine(() => {
      started.resolve(undefined)
      return gate.promise
    })
    const server = await start(engine)
    let request: Promise<Response> | undefined
    try {
      request = postTranslate(server, { text: 'slow', targetLang: 'es' })
      await started.promise

      const closing = server.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(engine.closeCount).toBe(0)

      gate.resolve('listo')
      const response = await request
      expect(response.status).toBe(200)
      await closing
      expect(engine.closeCount).toBe(0)
    } finally {
      gate.resolve('cleanup')
      if (request) await Promise.allSettled([request])
      await server.close()
    }
  })
})

describe('parseBrowserTranslateServerArgs', () => {
  it('parses defaults and flags', async () => {
    await withCleanTokenEnv(() => {
      const defaults = parseBrowserTranslateServerArgs([])
      expect(defaults).toMatchObject({
        host: '127.0.0.1',
        port: 8787,
        headless: true,
        concurrency: 4,
        queueLimit: 32,
        cacheEntries: 1000,
        cacheMaxBytes: 64 * 1024 * 1024,
        help: false,
        version: false,
      })

      const parsed = parseBrowserTranslateServerArgs([
        '--host',
        '0.0.0.0',
        '--port=9999',
        '--token',
        'secret',
        '--chrome-path',
        '/tmp/chrome',
        '--headed',
        '--concurrency',
        '2',
        '--queue-limit=0',
        '--cache-entries',
        '7',
        '--cache-max-bytes=123',
      ])
      expect(parsed).toMatchObject({
        host: '0.0.0.0',
        port: 9999,
        token: 'secret',
        chromePath: '/tmp/chrome',
        headless: false,
        concurrency: 2,
        queueLimit: 0,
        cacheEntries: 7,
        cacheMaxBytes: 123,
      })
    })
  })

  it('reads the token from --token-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-browser-translate-'))
    try {
      const file = join(dir, 'token')
      await writeFile(file, 'file-secret\n', 'utf8')
      await withCleanTokenEnv(() => {
        const parsed = parseBrowserTranslateServerArgs(['--token-file', file])
        expect(parsed.token).toBe('file-secret')
        expect(parsed.tokenFile).toBe(file)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid ports and unknown flags', () => {
    expect(() => parseBrowserTranslateServerArgs(['--port', 'abc'])).toThrow(/--port/)
    expect(() => parseBrowserTranslateServerArgs(['--port', '70000'])).toThrow(/--port/)
    expect(() => parseBrowserTranslateServerArgs(['--bogus'])).toThrow(/Unknown option/)
  })
})

describe('bind guard', () => {
  it('refuses non-loopback hosts without a token', async () => {
    await withCleanTokenEnv(async () => {
      const engine = makeEngine(() => 'never')
      await expect(
        startBrowserTranslateServer({ host: '0.0.0.0', port: 0, engine }),
      ).rejects.toThrow(/without a token/)
    })
  })
})
