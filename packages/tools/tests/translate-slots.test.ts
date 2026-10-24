import { defineTool } from '@mt/core'
import type { Tool, ToolContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ParagraphTranslatorState,
  type TitleTranslatorState,
  createParagraphTranslator,
  createTitleTranslator,
  paragraphTranslator,
  titleTranslator,
} from '../src/chapter-translator.js'
import { mockLlmCall } from '../src/llm-gate.js'
import { llmTranslate } from '../src/llm-translate.js'
import {
  type TranslateInput,
  type TranslateOutput,
  createTranslateText,
  translateText,
} from '../src/translate-text.js'

const ctx = {} as ToolContext
const ctxWith = (global: Record<string, unknown>): ToolContext =>
  ({ run: { global: { settings: {}, env: {}, ...global } } }) as unknown as ToolContext

afterEach(() => vi.unstubAllGlobals())

/** Offline translator: wraps the text in «t»...«/t». */
const mockTranslator = defineTool<TranslateInput, TranslateOutput>({
  name: 'mock-translator',
  version: '1.0.0',
  mdDescription: 'Offline mock translator.',
  invoke: async (env) => ({
    item: { translatedText: `«t»${env.item.text}«/t»` },
    meta: env.meta,
  }),
})

function wrap(tool: Tool<TranslateInput, TranslateOutput>) {
  return tool.invoke({ item: { text: 'hello', targetLang: 'ru' }, meta: {} }, ctx)
}

describe('translateText (composable)', () => {
  it('keeps name/version and exposes gate slots', () => {
    expect(translateText.name).toBe('translate-text')
    expect(translateText.version).toBe('1.0.0')
    expect(typeof translateText.invoke).toBe('function')
    expect(Object.keys(translateText.slots)).toEqual(['prepare', 'fit', 'call', 'parse', 'emit'])
  })

  it('default call backend POSTs to the router /api/translate', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ translatedText: 'привет', model: 'm', tokens: 3 }), {
          status: 200,
        })
      }),
    )
    const out = await wrap(translateText)
    expect(out.item).toEqual({ translatedText: 'привет', model: 'm', tokens: 3 })
    expect(calls[0]?.url).toBe('http://localhost:7777/api/translate')
    expect(calls[0]?.body).toEqual({ text: 'hello', targetLang: 'ru', sourceLang: undefined })
    expect(out.meta).toMatchObject({ translated: true, count: 1 })
  })

  it('router failure keeps the legacy error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(wrap(translateText)).rejects.toThrow('Translation failed: 500 nope')
  })

  it('llm backend with a mocked call: shared prompts with llmTranslate', async () => {
    const tool = createTranslateText({ backend: 'llm' })
    const mock = mockLlmCall(['привет'])
    const out = await tool.with({ call: mock }).invoke(
      { item: { text: 'hello', targetLang: 'ru', sourceLang: 'en' }, meta: {} },
      ctx,
    )
    expect(out.item).toMatchObject({ translatedText: 'привет' })
    expect(out.meta).toMatchObject({ translated: true })
    expect(mock.calls[0]?.messages[0]).toMatchObject({ role: 'system' })
    expect(mock.calls[0]?.messages[0]?.content).toContain('en')
    expect(mock.calls[0]?.messages[0]?.content).toContain('ru')
    expect(mock.calls[0]?.messages[1]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('translateText and llmTranslate share the implementation', () => {
    // same slot layout, same normalize/toOutput (no duplicated prompt/parse logic)
    expect(Object.keys(llmTranslate.slots)).toEqual(Object.keys(translateText.slots))
    const viaLlmTranslate = llmTranslate.with({ call: mockLlmCall(['x']) })
    const viaTranslateText = createTranslateText({ backend: 'llm' }).with({ call: mockLlmCall(['x']) })
    return Promise.all([
      viaLlmTranslate.invoke({ item: { text: 'a', targetLang: 'ru' }, meta: {} }, ctx),
      viaTranslateText.invoke({ item: { text: 'a', targetLang: 'ru' }, meta: {} }, ctx),
    ]).then(([a, b]) => {
      expect(a.item).toEqual(b.item)
      expect(a.meta).toMatchObject({ translated: true })
    })
  })
})

describe('titleTranslator / paragraphTranslator (composable)', () => {
  const docChapter = `---
title: The Road
---

# The Road

Body text here.
`

  it('titleTranslator translates the doc title via the translate slot', async () => {
    const tool = createTitleTranslator({ translate: mockTranslator })
    const out = await tool.invoke({ item: { text: docChapter, targetLang: 'ru' }, meta: {} }, ctx)
    expect(out.item.titleTranslated).toBe(true)
    expect(out.item.text).toContain('«t»The Road«/t»')
    expect(out.meta).toMatchObject({ titleTranslated: true, count: 1 })
  })

  it('titleTranslator translates an H1-only chapter', async () => {
    const out = await createTitleTranslator({ translate: mockTranslator }).invoke(
      { item: { text: '# Hello\n\npara', targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.text).toContain('«t»Hello«/t»')
  })

  it('.with({ translate }) swaps the translator for the whole tool', async () => {
    const slotMock = defineTool<TitleTranslatorState, TitleTranslatorState>({
      name: 'state-mock',
      version: '1.0.0',
      mdDescription: 'state-level mock translate slot',
      invoke: async (env) => ({
        ...env,
        item: { ...env.item, translatedTitle: `«m»${env.item.title ?? ''}«/m»` },
      }),
    })
    const out = await titleTranslator.with({ translate: slotMock }).invoke(
      { item: { text: docChapter, targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.text).toContain('«m»The Road«/m»')
  })

  it('batched envelopes keep per-item results', async () => {
    const out = await createTitleTranslator({ translate: mockTranslator }).invoke(
      {
        item: { text: docChapter, targetLang: 'ru' },
        items: [
          { text: docChapter, targetLang: 'ru' },
          { text: 'no title markers here', targetLang: 'ru' },
        ],
        meta: {},
      },
      ctx,
    )
    expect(Array.isArray(out.item)).toBe(true)
    expect(out.meta.count).toBe(2)
  })

  it('paragraphTranslator translates each paragraph and rebuilds the doc', async () => {
    const out = await createParagraphTranslator({ translate: mockTranslator }).invoke(
      { item: { text: docChapter, targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.paragraphsTranslated).toBe(1)
    expect(out.item.text).toContain('«t»Body text here.«/t»')
    expect(out.meta.paragraphsTranslated).toBe(1)
  })

  it('paragraphTranslator falls back to raw paragraph splitting', async () => {
    const out = await createParagraphTranslator({ translate: mockTranslator }).invoke(
      { item: { text: 'First para here.\n\nSecond para here.', targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.paragraphsTranslated).toBe(2)
    expect(out.item.text).toContain('«t»First para here.«/t»')
    expect(out.item.text).toContain('«t»Second para here.«/t»')
  })

  it('.with({ translate }) swaps the paragraph translator too', async () => {
    const slotMock = defineTool<ParagraphTranslatorState, ParagraphTranslatorState>({
      name: 'state-mock-p',
      version: '1.0.0',
      mdDescription: 'state-level mock translate slot',
      invoke: async (env) => ({
        ...env,
        item: { ...env.item, translated: env.item.paragraphs.map((p) => `«p»${p}«/p»`) },
      }),
    })
    const out = await paragraphTranslator.with({ translate: slotMock }).invoke(
      { item: { text: docChapter, targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.text).toContain('«p»Body text here.«/p»')
  })
})
