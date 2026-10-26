import { defineTool, getVariable, withItem } from '@mt/core'
import type { Tool, ToolContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockLlmCall } from '../src/core/llm-gate.js'
import { llmTranslate } from '../src/core/llm-translate.js'
import {
  type TranslateInput,
  type TranslateOutput,
  createTranslateText,
  translateText,
} from '../src/core/translate-text.js'
import {
  type ParagraphTranslatorState,
  type TitleTranslatorState,
  createParagraphTranslator,
  createTitleTranslator,
  paragraphTranslator,
  titleTranslator,
} from '../src/modification/chapter-translator.js'
import { varsOf } from './helpers/llm-vars.js'

const ctx = {} as ToolContext

afterEach(() => vi.unstubAllGlobals())

/** Offline translator: wraps the text in «t»...«/t». */
const mockTranslator = defineTool<TranslateInput, TranslateOutput>({
  name: 'mock-translator',
  version: '1.0.0',
  mdDescription: 'Offline mock translator.',
  invoke: async (env) => withItem(env, { translatedText: `«t»${env.item.text}«/t»` }),
})

function wrap(tool: Tool<TranslateInput, TranslateOutput>) {
  return tool.invoke(
    { id: 'ex-test', variables: [], item: { text: 'hello', targetLang: 'ru' }, meta: {} },
    ctx,
  )
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
    expect(varsOf(out)).toMatchObject({ translated: true, count: 1 })
  })

  it('router failure keeps the legacy error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    await expect(wrap(translateText)).rejects.toThrow('Translation failed: 500 nope')
  })

  it('llm backend with a mocked call: shared prompts with llmTranslate', async () => {
    const tool = createTranslateText({ backend: 'llm' })
    const mock = mockLlmCall(['привет'])
    const out = await tool.with({ call: mock }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: 'hello', targetLang: 'ru', sourceLang: 'en' },
        meta: {},
      },
      ctx,
    )
    expect(out.item).toMatchObject({ translatedText: 'привет' })
    expect(varsOf(out)).toMatchObject({ translated: true })
    expect(mock.calls[0]?.messages[0]).toMatchObject({ role: 'system' })
    expect(mock.calls[0]?.messages[0]?.content).toContain('en')
    expect(mock.calls[0]?.messages[0]?.content).toContain('ru')
    expect(mock.calls[0]?.messages[1]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('strips the <terms> report block and <think> from the model reply', async () => {
    const tool = createTranslateText({ backend: 'llm' })
    const reply =
      '<think>hm</think>привет мир <terms>\\[{"term":"Aldric","ru":"Алдрик","type":"character"}]</terms>'
    const out = await tool
      .with({ call: mockLlmCall([reply]) })
      .invoke(
        { id: 'ex-test', variables: [], item: { text: 'hello', targetLang: 'ru' }, meta: {} },
        ctx,
      )
    expect(out.item).toMatchObject({ translatedText: 'привет мир' })
  })

  it('translateText and llmTranslate share the implementation', () => {
    // same slot layout, same normalize/toOutput (no duplicated prompt/parse logic)
    expect(Object.keys(llmTranslate.slots)).toEqual(Object.keys(translateText.slots))
    const viaLlmTranslate = llmTranslate.with({ call: mockLlmCall(['x']) })
    const viaTranslateText = createTranslateText({ backend: 'llm' }).with({
      call: mockLlmCall(['x']),
    })
    return Promise.all([
      viaLlmTranslate.invoke(
        { id: 'ex-test', variables: [], item: { text: 'a', targetLang: 'ru' }, meta: {} },
        ctx,
      ),
      viaTranslateText.invoke(
        { id: 'ex-test', variables: [], item: { text: 'a', targetLang: 'ru' }, meta: {} },
        ctx,
      ),
    ]).then(([a, b]) => {
      expect(a.item).toEqual(b.item)
      expect(varsOf(a)).toMatchObject({ translated: true })
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
    const out = await tool.invoke(
      { id: 'ex-test', variables: [], item: { text: docChapter, targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.titleTranslated).toBe(true)
    expect(out.item.text).toContain('«t»The Road«/t»')
    expect(varsOf(out)).toMatchObject({ titleTranslated: true, count: 1 })
  })

  it('titleTranslator translates an H1-only chapter', async () => {
    const out = await createTitleTranslator({ translate: mockTranslator }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: '# Hello\n\npara', targetLang: 'ru' },
        meta: {},
      },
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
    const out = await titleTranslator
      .with({ translate: slotMock })
      .invoke(
        { id: 'ex-test', variables: [], item: { text: docChapter, targetLang: 'ru' }, meta: {} },
        ctx,
      )
    expect(out.item.text).toContain('«m»The Road«/m»')
  })

  it('batched envelopes keep per-item results', async () => {
    const out = await createTitleTranslator({ translate: mockTranslator }).invoke(
      {
        id: 'ex-test',
        variables: [],
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
    expect(getVariable(out, 'count')).toBe(2)
  })

  it('paragraphTranslator translates each paragraph and rebuilds the doc', async () => {
    const out = await createParagraphTranslator({ translate: mockTranslator }).invoke(
      { id: 'ex-test', variables: [], item: { text: docChapter, targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(out.item.paragraphsTranslated).toBe(1)
    expect(out.item.text).toContain('«t»Body text here.«/t»')
    expect(getVariable(out, 'paragraphsTranslated')).toBe(1)
  })

  it('paragraphTranslator falls back to raw paragraph splitting', async () => {
    const out = await createParagraphTranslator({ translate: mockTranslator }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: 'First para here.\n\nSecond para here.', targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    expect(out.item.paragraphsTranslated).toBe(2)
    expect(out.item.text).toContain('«t»First para here.«/t»')
    expect(out.item.text).toContain('«t»Second para here.«/t»')
  })

  it('paragraph translator bounds in-flight calls and preserves order', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const started: Array<() => void> = []
    const tracker = defineTool<TranslateInput, TranslateOutput>({
      name: 'tracker-translator',
      version: '1.0.0',
      mdDescription: 'Tracks in-flight calls; resolves when released.',
      invoke: async (env) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => started.push(resolve))
        inFlight--
        return withItem(env, { translatedText: `«t»${env.item.text}«/t»` })
      },
    })
    const tool = createParagraphTranslator({ translate: tracker, concurrency: 3 })
    const paras = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    const pending = tool.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: paras.join('\n\n'), targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    await vi.waitFor(() => expect(started).toHaveLength(3))
    expect(maxInFlight).toBe(3)
    for (const release of started.splice(0)) release()
    await vi.waitFor(() => expect(started).toHaveLength(3))
    expect(maxInFlight).toBe(3)
    for (const release of started.splice(0)) release()
    const out = await pending
    expect(out.item.paragraphsTranslated).toBe(6)
    expect(out.item.text).toBe(paras.map((p) => `«t»${p}«/t»`).join('\n\n'))
  })

  it('memoizes paragraph results across retries: only failed paragraphs are re-translated', async () => {
    const calls: string[] = []
    let failed = false
    const flaky = defineTool<TranslateInput, TranslateOutput>({
      name: 'flaky-translator',
      version: '1.0.0',
      mdDescription: 'Fails once on p3.',
      invoke: async (env) => {
        calls.push(env.item.text)
        if (env.item.text === 'p3' && !failed) {
          failed = true
          throw new Error('boom p3')
        }
        return withItem(env, { translatedText: `«t»${env.item.text}«/t»` })
      },
    })
    const tool = createParagraphTranslator({ translate: flaky, concurrency: 2 })
    const paras = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    const input = { text: paras.join('\n\n'), targetLang: 'ru' }
    await expect(
      tool.invoke({ id: 'ex-test', variables: [], item: input, meta: {} }, ctx),
    ).rejects.toThrow('boom p3')
    const out = await tool.invoke({ id: 'ex-test', variables: [], item: input, meta: {} }, ctx)
    expect(out.item.text).toBe(paras.map((p) => `«t»${p}«/t»`).join('\n\n'))
    expect(calls.filter((c) => c === 'p3')).toHaveLength(2)
    expect(calls.filter((c) => c !== 'p3')).toEqual(['p0', 'p1', 'p2', 'p4', 'p5'])
  })

  it('skips the memo when the translator is non-idempotent', async () => {
    const calls: string[] = []
    let failed = false
    const nonIdempotent = defineTool<TranslateInput, TranslateOutput>({
      name: 'non-idempotent-translator',
      version: '1.0.0',
      mdDescription: 'Fails once; not idempotent.',
      idempotent: false,
      invoke: async (env) => {
        calls.push(env.item.text)
        if (!failed) {
          failed = true
          throw new Error('boom once')
        }
        return withItem(env, { translatedText: `«t»${env.item.text}«/t»` })
      },
    })
    const tool = createParagraphTranslator({ translate: nonIdempotent })
    const input = { text: 'para one\n\npara two', targetLang: 'ru' }
    await expect(
      tool.invoke({ id: 'ex-test', variables: [], item: input, meta: {} }, ctx),
    ).rejects.toThrow('boom once')
    await tool.invoke({ id: 'ex-test', variables: [], item: input, meta: {} }, ctx)
    // no memo: the retry re-translates every paragraph
    expect(calls).toEqual(['para one', 'para two', 'para one', 'para two'])
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
    const out = await paragraphTranslator
      .with({ translate: slotMock })
      .invoke(
        { id: 'ex-test', variables: [], item: { text: docChapter, targetLang: 'ru' }, meta: {} },
        ctx,
      )
    expect(out.item.text).toContain('«p»Body text here.«/p»')
  })
})
