import { fileURLToPath } from 'node:url'
import { createExchange, getVariable, setVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { TranslateInput } from '../core/translate-text.js'
import { startBrowserTranslateServer } from './browser-translate-server.js'
import {
  type BrowserTranslateEngine,
  type TranslationChunk,
  buildTranslatePage,
  createBrowserTranslate,
  createHeadlessGoogleEngine,
  createRemoteGoogleEngine,
  resolveChromePath,
  splitTranslationChunks,
} from './browser-translate.js'

const ctx = {} as ToolContext

interface EngineCall {
  text: string
  sourceLang?: string
  targetLang: string
}

interface BrowserTranslateInfo {
  engine: string
  model: string
  ms: number
  targetLang: string
  sourceLang: string
  transport: 'local' | 'remote'
  endpoint?: string
}

function injectedEngine(
  translate: (input: EngineCall) => string | Promise<string>,
): BrowserTranslateEngine & { calls: EngineCall[] } {
  const calls: EngineCall[] = []
  return {
    calls,
    async translate(input) {
      calls.push({ ...input })
      return translate(input)
    },
  }
}

function longParagraphs(): string {
  return Array.from({ length: 5 }, (_, i) => `p${i} `.padEnd(1000, 'x')).join('\n\n')
}

function longSentences(): string {
  return Array.from({ length: 25 }, (_, i) => {
    const prefix = `sentence ${i} `
    return `${prefix}${'x'.repeat(180 - prefix.length)}.`
  }).join(' ')
}

function restoreChromeEnv(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, 'MT_CHROME_PATH')
  else process.env.MT_CHROME_PATH = value
}

function withChromeEnv(value: string, run: () => void): void {
  const previous = process.env.MT_CHROME_PATH
  process.env.MT_CHROME_PATH = value
  try {
    run()
  } finally {
    restoreChromeEnv(previous)
  }
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

interface FetchCall {
  url: string
  init: RequestInit
}

function fetchStub(handler: (call: FetchCall, index: number) => Promise<Response> | Response): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { fetch: fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('splitTranslationChunks', () => {
  it('preserves paragraph separators when long text is split', () => {
    const text = longParagraphs()
    const chunks = splitTranslationChunks(text)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true)
    expect(chunks.map((chunk) => chunk.leading + chunk.text + chunk.trailing).join('')).toBe(text)
    expect(chunks.some((chunk) => chunk.trailing.includes('\n\n'))).toBe(true)
  })

  it('preserves spaces at sentence chunk joins', () => {
    const text = longSentences()
    const chunks = splitTranslationChunks(text)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true)
    expect(chunks.map((chunk) => chunk.leading + chunk.text + chunk.trailing).join('')).toBe(text)

    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]
      const next = chunks[i]
      const boundary = `${previous?.trailing ?? ''}${next?.leading ?? ''}`
      expect(boundary).toContain(' ')
    }
  })

  it('keeps leading and trailing whitespace around the core', () => {
    const chunks = splitTranslationChunks('  Hello world.  ', 100)
    expect(chunks).toEqual([{ leading: '  ', text: 'Hello world.', trailing: '  ' }])
  })

  it('returns no chunks for whitespace-only text', () => {
    expect(splitTranslationChunks('  \n\t ')).toEqual([])
  })
})

describe('browserTranslate', () => {
  it('throws when no target language is configured', async () => {
    const engine = injectedEngine(() => 'translated')
    const tool = createBrowserTranslate({ engine })
    const input = { text: 'Hello' } as TranslateInput

    await expect(tool.invoke(createExchange(input), ctx)).rejects.toThrow(
      /browser-translate: targetLang is required/,
    )
    expect(engine.calls).toHaveLength(0)
  })

  it('falls back to the option targetLang', async () => {
    const engine = injectedEngine(({ text, targetLang }) => `[${targetLang}] ${text}`)
    const tool = createBrowserTranslate({ engine, targetLang: 'de' })
    const input = { text: 'Hello' } as TranslateInput

    const out = await tool.invoke(createExchange(input), ctx)

    expect(out.item.translatedText).toBe('[de] Hello')
    expect(engine.calls).toEqual([{ text: 'Hello', sourceLang: 'auto', targetLang: 'de' }])
  })

  it('translates a single item and preserves meta and variables', async () => {
    const engine = injectedEngine(({ text, targetLang }) => `[${targetLang}] ${text}`)
    const tool = createBrowserTranslate({ engine })
    const input: TranslateInput = { text: 'Hello', sourceLang: 'en', targetLang: 'es' }
    const env = setVariable(
      createExchange(input, { id: 'ex-browser', meta: { chapterId: 'ch-1' } }),
      'keepMe',
      42,
    )

    const out = await tool.invoke(env, ctx)

    expect(out.id).toBe('ex-browser')
    expect(out.meta.chapterId).toBe('ch-1')
    expect(getVariable(out, 'keepMe')).toBe(42)
    expect(out.item.translatedText).toBe('[es] Hello')

    const info = getVariable<BrowserTranslateInfo>(out, 'browserTranslate')
    expect(info).toMatchObject({
      engine: 'google-endpoint',
      model: 'google-translate-web',
      targetLang: 'es',
      sourceLang: 'en',
      transport: 'local',
    })
    expect(info?.ms).toBeGreaterThanOrEqual(0)
  })

  it('translates batch items in order and keeps item equal to the first output', async () => {
    const engine = injectedEngine(async ({ text }) => `translated:${text}`)
    const tool = createBrowserTranslate({ engine, concurrency: 3 })
    const inputs: TranslateInput[] = [
      { text: 'one', targetLang: 'es' },
      { text: 'two', targetLang: 'es' },
      { text: 'three', targetLang: 'es' },
    ]
    const first = inputs[0] ?? { text: '', targetLang: 'es' }

    const out = await tool.invoke(createExchange(first, { id: 'ex-batch', items: inputs }), ctx)

    expect(out.id).toBe('ex-batch')
    expect(out.items).toHaveLength(inputs.length)
    expect(out.item).toEqual(out.items?.[0])
    expect(out.items?.map((item) => item.translatedText)).toEqual([
      'translated:one',
      'translated:two',
      'translated:three',
    ])
    const info = getVariable<BrowserTranslateInfo[]>(out, 'browserTranslate')
    expect(info).toHaveLength(3)
    expect(info?.map((entry) => entry.targetLang)).toEqual(['es', 'es', 'es'])
    expect(info?.every((entry) => entry.transport === 'local')).toBe(true)
  })

  it('short-circuits empty text without calling the engine', async () => {
    const engine = injectedEngine(() => 'should not run')
    const tool = createBrowserTranslate({ engine, targetLang: 'es' })
    const input: TranslateInput = { text: '  \n\t ', targetLang: 'es' }

    const out = await tool.invoke(createExchange(input), ctx)

    expect(out.item.translatedText).toBe('')
    expect(engine.calls).toHaveLength(0)
  })

  it('propagates injected engine errors', async () => {
    const engine: BrowserTranslateEngine = {
      async translate() {
        throw new Error('engine boom')
      },
    }
    const tool = createBrowserTranslate({ engine })

    await expect(
      tool.invoke(createExchange({ text: 'Hello', targetLang: 'es' }), ctx),
    ).rejects.toThrow('engine boom')
  })
})

describe('browserTranslate remote', () => {
  it('selects a remote worker from the option, env, and keeps explicit engines local', async () => {
    const workerEngine = injectedEngine(({ text }) => `remote:${text}`)
    const server = await startBrowserTranslateServer({ port: 0, engine: workerEngine })
    try {
      const fromOption = createBrowserTranslate({ remoteUrl: `${server.url}/` })
      const optionOut = await fromOption.invoke(
        createExchange({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
        ctx,
      )
      expect(optionOut.item.translatedText).toBe('remote:Hello')
      expect(getVariable<BrowserTranslateInfo>(optionOut, 'browserTranslate')).toMatchObject({
        transport: 'remote',
        endpoint: `${server.url}/translate`,
      })

      await withEnv('MT_BROWSER_TRANSLATE_URL', server.url, async () => {
        const fromEnv = createBrowserTranslate({ targetLang: 'es' })
        const envOut = await fromEnv.invoke(
          createExchange({ text: 'World', targetLang: 'es' }),
          ctx,
        )
        expect(envOut.item.translatedText).toBe('remote:World')
        expect(getVariable<BrowserTranslateInfo>(envOut, 'browserTranslate')).toMatchObject({
          transport: 'remote',
          endpoint: `${server.url}/translate`,
        })

        const localEngine = injectedEngine(({ text }) => `local:${text}`)
        const explicit = createBrowserTranslate({ engine: localEngine })
        const localOut = await explicit.invoke(
          createExchange({ text: 'Explicit', targetLang: 'es' }),
          ctx,
        )
        expect(localOut.item.translatedText).toBe('local:Explicit')
        expect(getVariable<BrowserTranslateInfo>(localOut, 'browserTranslate')).toMatchObject({
          transport: 'local',
        })
        expect(localEngine.calls).toHaveLength(1)
      })
    } finally {
      await server.close()
    }
  })

  it('sends the remote payload with a bearer token and normalizes the URL', async () => {
    const stub = fetchStub(() => jsonResponse({ translatedText: 'hola' }))
    const engine = createRemoteGoogleEngine({
      url: 'http://worker:8787/translate/',
      token: 'secret',
      cache: false,
      fetch: stub.fetch,
    })

    expect(engine.transport).toBe('remote')
    expect(engine.endpoint).toBe('http://worker:8787/translate')

    const translated = await engine.translate({
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'es',
    })

    expect(translated).toBe('hola')
    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]
    expect(call?.url).toBe('http://worker:8787/translate')
    expect(call?.init.method).toBe('POST')
    const headers = new Headers(call?.init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(JSON.parse(String(call?.init.body))).toEqual({
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'es',
      cache: false,
    })
  })

  it('uses explicit remote engine metadata in the browserTranslate variable', async () => {
    const stub = fetchStub(() => jsonResponse({ translatedText: 'hola' }))
    const remote = createRemoteGoogleEngine({
      url: 'http://worker:8787',
      fetch: stub.fetch,
    })
    const tool = createBrowserTranslate({ engine: remote })

    const out = await tool.invoke(
      createExchange({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
      ctx,
    )

    expect(out.item.translatedText).toBe('hola')
    expect(getVariable<BrowserTranslateInfo>(out, 'browserTranslate')).toMatchObject({
      transport: 'remote',
      endpoint: 'http://worker:8787/translate',
    })
  })

  it('rejects remote URLs with credentials and redacts userinfo', () => {
    let credentialError = ''
    try {
      createRemoteGoogleEngine({ url: 'http://user:pass@worker:8787' })
    } catch (error) {
      credentialError = error instanceof Error ? error.message : String(error)
    }
    expect(credentialError).toMatch(/credentials/)
    expect(credentialError).toContain('[redacted]')
    expect(credentialError).not.toContain('user:pass')

    let invalidError = ''
    try {
      createRemoteGoogleEngine({ url: 'http://user:secret@' })
    } catch (error) {
      invalidError = error instanceof Error ? error.message : String(error)
    }
    expect(invalidError).toMatch(/invalid remote URL/)
    expect(invalidError).toContain('[redacted]')
    expect(invalidError).not.toContain('user:secret')
  })

  it('retries 429 responses and then succeeds', async () => {
    const stub = fetchStub((_call, index) => {
      if (index === 0) {
        return new Response(JSON.stringify({ error: 'busy' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      }
      return jsonResponse({ translatedText: 'hola' })
    })
    const engine = createRemoteGoogleEngine({
      url: 'http://worker:8787',
      retries: 1,
      fetch: stub.fetch,
    })

    await expect(
      engine.translate({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
    ).resolves.toBe('hola')
    expect(stub.calls).toHaveLength(2)
  })

  it('does not retry a 400 response', async () => {
    const stub = fetchStub(() => jsonResponse({ error: 'bad request' }, 400))
    const engine = createRemoteGoogleEngine({
      url: 'http://worker:8787',
      retries: 3,
      fetch: stub.fetch,
    })

    await expect(
      engine.translate({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
    ).rejects.toThrow(/HTTP 400/)
    expect(stub.calls).toHaveLength(1)
  })

  it('fails clearly for malformed remote responses', async () => {
    const malformed = fetchStub(() => new Response('not json', { status: 200 }))
    const malformedEngine = createRemoteGoogleEngine({
      url: 'http://worker:8787',
      fetch: malformed.fetch,
    })
    await expect(
      malformedEngine.translate({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
    ).rejects.toThrow(/not valid JSON/)

    const missing = fetchStub(() => jsonResponse({ translatedText: '' }))
    const missingEngine = createRemoteGoogleEngine({
      url: 'http://worker:8787',
      fetch: missing.fetch,
    })
    await expect(
      missingEngine.translate({ text: 'Hello', sourceLang: 'en', targetLang: 'es' }),
    ).rejects.toThrow(/missing translatedText/)
  })
})

describe('buildTranslatePage', () => {
  it('escapes user text, embeds chunks, and keeps target language', () => {
    const html = buildTranslatePage({
      text: 'before </pre><script>alert(1)</script> after',
      sourceLang: 'en',
      targetLang: 'es',
    })

    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('</pre><script>')
    expect(html).toContain('https://translate.googleapis.com/translate_a/single')
    expect(html).toContain('data-target-lang="es"')
    expect(html).toContain('id="mt-chunks"')
    expect(html).toContain('<html lang="en"')
    expect(html).toContain('\\u003c')
  })

  it('escapes line separators in the embedded chunk JSON', () => {
    const html = buildTranslatePage({
      text: 'left\u2028middle\u2029right',
      sourceLang: 'en',
      targetLang: 'es',
    })
    const marker = '<script id="mt-chunks" type="application/json">'
    const start = html.indexOf(marker) + marker.length
    const end = html.indexOf('</script>', start)
    const json = html.slice(start, end)
    expect(json).toContain('\\u2028')
    expect(json).toContain('\\u2029')
    expect(json).not.toContain('\u2028')
    expect(json).not.toContain('\u2029')
  })

  it('uses lang=en when sourceLang is auto', () => {
    const html = buildTranslatePage({ text: 'Hello', sourceLang: 'auto', targetLang: 'es' })
    expect(html).toContain('<html lang="en"')
    expect(html).toContain('data-source-lang="auto"')
  })

  it('embeds chunk metadata that reconstructs the original text', () => {
    const text = longParagraphs()
    const html = buildTranslatePage({ text, sourceLang: 'en', targetLang: 'es' })
    const marker = '<script id="mt-chunks" type="application/json">'
    const start = html.indexOf(marker) + marker.length
    const end = html.indexOf('</script>', start)
    const chunks = JSON.parse(html.slice(start, end)) as TranslationChunk[]
    expect(chunks.map((chunk) => chunk.leading + chunk.text + chunk.trailing).join('')).toBe(text)
  })
})

describe('resolveChromePath', () => {
  it('prefers an explicit path over MT_CHROME_PATH and uses the env path as fallback', () => {
    const explicit = process.execPath
    const envPath = fileURLToPath(new URL('../../package.json', import.meta.url))

    withChromeEnv(envPath, () => {
      expect(resolveChromePath(explicit)).toBe(explicit)
      expect(resolveChromePath()).toBe(envPath)
    })
  })

  it('throws clear errors for missing explicit and env paths', () => {
    expect(() => resolveChromePath('/definitely/not/chrome')).toThrow(/chromePath/)

    withChromeEnv('/definitely/not/chrome', () => {
      expect(() => resolveChromePath()).toThrow(/MT_CHROME_PATH/)
    })
  })
})

describe.skipIf(process.env.MT_BROWSER_TRANSLATE_E2E !== '1')(
  'browserTranslate real Chrome',
  () => {
    it('translates Hello world from English to Spanish', async () => {
      const engine = createHeadlessGoogleEngine()
      try {
        const tool = createBrowserTranslate({ engine })
        const out = await tool.invoke(
          createExchange({ text: 'Hello world', sourceLang: 'en', targetLang: 'es' }),
          ctx,
        )
        expect(out.item.translatedText.toLowerCase()).toContain('hola')
      } finally {
        await engine.close?.()
      }
    }, 120_000)

    it('translates multi-paragraph input', async () => {
      const engine = createHeadlessGoogleEngine()
      try {
        const tool = createBrowserTranslate({ engine })
        const out = await tool.invoke(
          createExchange({
            text: 'Hello world.\n\nGoodbye world.',
            sourceLang: 'en',
            targetLang: 'es',
          }),
          ctx,
        )
        const translated = out.item.translatedText.toLowerCase()
        expect(translated).toContain('hola')
        expect(translated).toContain('adiós')
        expect(out.item.translatedText).toContain('\n\n')
      } finally {
        await engine.close?.()
      }
    }, 120_000)

    it('translates through a real remote worker', async () => {
      const server = await startBrowserTranslateServer({ port: 0, timeoutMs: 120_000 })
      try {
        const remote = createRemoteGoogleEngine({ url: server.url, timeoutMs: 120_000 })
        const tool = createBrowserTranslate({ engine: remote })
        const out = await tool.invoke(
          createExchange({ text: 'Hello world', sourceLang: 'en', targetLang: 'es' }),
          ctx,
        )
        expect(out.item.translatedText.toLowerCase()).toContain('hola')
      } finally {
        await server.close()
      }
    }, 120_000)
  },
)
