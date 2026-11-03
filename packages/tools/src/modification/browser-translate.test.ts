import { fileURLToPath } from 'node:url'
import { createExchange, getVariable, setVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { TranslateInput } from '../core/translate-text.js'
import {
  type BrowserTranslateEngine,
  type TranslationChunk,
  buildTranslatePage,
  createBrowserTranslate,
  createHeadlessGoogleEngine,
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
  },
)
