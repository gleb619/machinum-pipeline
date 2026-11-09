import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, getVariable, variable } from '@mt/core'
import type { Exchange, MdOutputEntry, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { LlmError } from '../src/core/llm-errors.js'
import { createAnalyzeOutputs } from '../src/modification/analyze-outputs.js'
import { createTranslateOutputs } from '../src/modification/translate-outputs.js'
import {
  chapterRecordMapper,
  lineTextToMarkdown,
  toChapterRecord,
  unwrapMarkdownText,
} from '../src/normalization/chapter-record.js'
import { readGlossaryFile } from '../src/normalization/glossary-extractor.js'
import { createLlmSummaryWithFallback } from '../src/normalization/llm-summary.js'
import { createLlmTypoFix } from '../src/normalization/llm-typo-fix.js'
import {
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  loadGlossaryOrEmpty,
  onlyChapters,
  titleOf,
  translateConcurrency,
  translateTaggedChapter,
} from '../src/normalization/translation-stage.js'
import { chapterPairsLinter } from '../src/verification/chapter-pairs-linter.js'
import { LineParityError } from '../src/verification/line-parity-linter.js'

const ctx = { run: { global: {} } } as unknown as ToolContext
const reply = (content: string) => async () => ({
  content,
  model: 'm',
  tokens: 0,
  promptTokens: 0,
  completionTokens: 0,
})

function chaptersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-stage-'))
  mkdirSync(join(dir, 'schema'))
  writeFileSync(join(dir, 'schema', 'chapter1.summary.md'), '# T\n\n## Summary\n\nShort.\n')
  writeFileSync(join(dir, 'glossary.json'), JSON.stringify({ terms: [] }))
  return dir
}

describe('chapter record tools', () => {
  it('toChapterRecord reads the number from the title, else the key', () => {
    expect(toChapterRecord({ key: 'k', value: 'Chapter 7: Hi\nbody' })).toEqual({
      title: 'Chapter 7: Hi',
      body: 'body',
      chapterNum: 7,
    })
    expect(toChapterRecord({ key: 'x/chapter-3', value: 'Prologue\nb' }).chapterNum).toBe(3)
    expect(() => toChapterRecord({ key: 'x', value: 'Prologue' })).toThrow(/chapter number/)
  })

  it('maps -> markdown -> unwrap', async () => {
    const mapped = await chapterRecordMapper.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { key: 'k', value: 'Chapter 2: A\nl1\n\nl2' },
        meta: {},
      },
      ctx,
    )
    expect(mapped.meta.chapterNum).toBe(2)
    const md = await lineTextToMarkdown.invoke(mapped, ctx)
    expect(md.item.text).toBe('# Chapter 2: A\n\nl1\n\nl2\n')
    const un = await unwrapMarkdownText.invoke(
      { id: 'ex-test', variables: [], item: { text: '\\[sys\\]' } as never, meta: {} },
      ctx,
    )
    expect(un.item).toBe('[sys]')
  })
})

describe('llm typo fix / summary', () => {
  it('keeps the original when the line count changes; pass-through when disabled', async () => {
    const bad = createLlmTypoFix({ call: reply('a\nb') })
    expect(
      (await bad.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)).item,
    ).toBe('x')
    const good = createLlmTypoFix({ call: reply(' fixed ') })
    const out = await good.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)
    expect(out.item).toBe('fixed')
    expect(getVariable(out, 'llmFixed')).toBe(true)
    const off = createLlmTypoFix({ call: reply('never'), enabled: false })
    expect(
      (await off.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)).item,
    ).toBe('x')
  })

  it('summary tool passes through when disabled', async () => {
    const off = createLlmSummaryWithFallback({ call: reply('never'), enabled: false })
    const env = createExchange('x', { variables: [variable('summary', 'h')] })
    expect(await off.invoke(env, ctx)).toBe(env)
  })
})

describe('analyze / translate outputs', () => {
  const intents = (ex: Exchange<unknown>) => getVariable<MdOutputEntry[]>(ex, 'mdOutputs') ?? []

  it('analyze outputs: summary + tagged per chapter and the glossary', async () => {
    const tool = createAnalyzeOutputs({ log: false })
    const res = await tool.invoke(
      {
        ...createExchange('', {
          variables: [
            variable('summaryByItem', ['S1']),
            variable('taggedItems', ['# Chapter 1: A\n\nTAG']),
            variable('glossaryJson', '{}'),
          ],
        }),
        items: ['# Chapter 1: A\n\nHe ran.'],
      },
      ctx,
    )
    const out = intents(res)
    expect(out.map((o) => `${o.subdir}/${o.filename}`)).toEqual([
      'schema/chapter1.summary.md',
      'en-tagged/chapter1.md',
      '/glossary.json',
    ])
    expect(out[0]?.content).toContain('## Summary\n\nS1')
    expect(out[1]?.content).toContain('TAG')
  })

  it('translate outputs: ru chapters + merged titles.json', async () => {
    const dir = chaptersDir()
    writeFileSync(join(dir, 'titles.json'), JSON.stringify({ '9': { en: 'Old', ru: 'Старый' } }))
    const tool = createTranslateOutputs({ chaptersDir: dir, log: false })
    const res = await tool.invoke(
      {
        ...createExchange(
          { en: '# Chapter 1: A', ru: '# Глава 1: А' },
          { variables: [variable('chapterNums', [1]), variable('titlesRu', ['Глава 1: А'])] },
        ),
        items: [{ en: '# Chapter 1: A', ru: '# Глава 1: А' }],
      },
      ctx,
    )
    const out = intents(res)
    expect(out[0]).toMatchObject({ subdir: 'ru', filename: 'chapter1.md' })
    const titles = JSON.parse(out[1]?.content ?? '{}')
    expect(titles['9'].ru).toBe('Старый')
    expect(titles['1']).toEqual({ en: 'Chapter 1: A', ru: 'Глава 1: А' })
  })
})

describe('readGlossaryFile', () => {
  it('undefined for missing / malformed files', async () => {
    const dir = chaptersDir()
    expect(await readGlossaryFile(join(dir, 'glossary.json'))).toEqual({ terms: [] })
    expect(await readGlossaryFile(join(dir, 'nope.json'))).toBeUndefined()
  })
})

describe('translation stage', () => {
  it('env helpers', () => {
    expect(onlyChapters({ MT_ONLY_CHAPTERS: '1, 3,x' })).toEqual(new Set([1, 3]))
    expect(onlyChapters({})).toBeUndefined()
    expect(translateConcurrency({ MT_TRANSLATE_CONCURRENCY: '3.7' })).toBe(3)
    expect(translateConcurrency({})).toBe(1)
  })

  it('titleOf takes the last heading', () => {
    expect(titleOf('---\nx: 1\n---\n# Глава 1')).toBe('Глава 1')
    expect(titleOf(' plain ')).toBe('plain')
  })

  it('chaptersToTitleInputs stashes the chapters', async () => {
    const res = await chaptersToTitleInputs.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: '' as never,
        items: ['# Chapter 1: A\nx', 'no heading'] as never,
        meta: {},
      },
      ctx,
    )
    expect(res.items?.map((i) => i.text)).toEqual(['# Chapter 1: A', '# Untitled'])
    expect(getVariable<string[]>(res, 'chapters')).toHaveLength(2)
  })

  it('translateTaggedChapter: line by line, keeps blanks/fences, memoises, rejects bad lines', async () => {
    const calls: string[] = []
    const base = {
      glossary: { terms: [] },
      summary: '',
      titleRu: 'Глава 1',
      concurrency: 2,
      memo: new Map<string, string>(),
    }
    const src = '# Chapter 1\n\nHello there.\n```\ncode\n```\nBye now.'
    const ru = await translateTaggedChapter(src, {
      ...base,
      ask: async (_s, u) => {
        calls.push(u)
        return 'Привет'
      },
    })
    expect(ru).toBe('# Глава 1\n\nПривет\n```\ncode\n```\nПривет')
    expect(calls).toHaveLength(2)
    await translateTaggedChapter(src, { ...base, ask: async () => 'нет' })
    expect(calls).toHaveLength(2) // second run served from the memo
    await expect(
      translateTaggedChapter('Hi there.', { ...base, memo: new Map(), ask: async () => '' }),
    ).rejects.toThrow()
  })

  it('translateTaggedChapter: passes the chapter so term timelines resolve at it', async () => {
    const systems: string[] = []
    const glossary = {
      terms: [
        {
          id: 'arin',
          term: 'Arin',
          type: 'character' as const,
          count: 2,
          firstChapter: 1,
          ru: 'Арин',
          aliases: [],
          ruTimeline: [{ chapter: 2, value: 'Арина' }],
        },
      ],
    }
    const src = '# Chapter 2\n\n<term id="arin">Arin</term> left.'
    await translateTaggedChapter(src, {
      glossary,
      summary: '',
      chapter: 1,
      titleRu: 'Глава 2',
      concurrency: 1,
      ask: async (s) => {
        systems.push(s)
        return 'Ушёл'
      },
    })
    expect(systems.some((s) => s.includes('Arin = Арин'))).toBe(true)
    expect(systems.some((s) => s.includes('Arin = Арина'))).toBe(false)
    await translateTaggedChapter(src, {
      glossary,
      summary: '',
      chapter: 2,
      titleRu: 'Глава 2',
      concurrency: 1,
      ask: async (s) => {
        systems.push(s)
        return 'Ушёл'
      },
    })
    expect(systems.some((s) => s.includes('Arin = Арина'))).toBe(true)
  })

  it('body translator + title translator + pairs linter work together', async () => {
    const dir = chaptersDir()
    const call = reply('Привет')
    const title = createGlossaryTitleTranslator({
      call: reply('Глава 1: Начало'),
      chaptersDir: dir,
    })
    const t = await title.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: '# Chapter 1: Start', targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    expect(t.item.translatedText).toBe('Глава 1: Начало')

    const body = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const res = await body.invoke(
      {
        ...createExchange(
          { text: '# Глава 1: Начало' },
          { variables: [variable('chapters', ['# Chapter 1: Start\n\nHello there.'])] },
        ),
        items: [{ text: '# Глава 1: Начало' }],
      },
      ctx,
    )
    expect(getVariable(res, 'chapterNums')).toEqual([1])
    expect(res.items?.[0]?.ru).toBe('# Глава 1: Начало\n\nПривет')
    const linted = await chapterPairsLinter.invoke(res as never, ctx)
    expect(getVariable(linted, 'parityByChapter')).toEqual({ '1': { errors: 0, warnings: 0 } })
  })

  it('names the failing chapter in the parity error', async () => {
    const pairs = [
      { en: '# Chapter 1\nОн вошёл.', ru: '# Глава 1\nОн вошёл.' },
      {
        en: '# Chapter 2\nHe walked into the hall.',
        ru: '# Chapter 2\nHe walked into the hall.',
      },
    ]
    const env = {
      id: 'ex-test',
      variables: [variable('chapterNums', [1, 2])],
      item: pairs[0],
      items: pairs,
      meta: {},
    }
    const err = (await chapterPairsLinter
      .invoke(env as never, ctx)
      .catch((e) => e)) as LineParityError
    expect(err).toBeInstanceOf(LineParityError)
    expect(err.where).toBe('chapter 2')
    expect(err.message).toContain('chapter 2')
    expect(err.report.issues).toContainEqual(expect.objectContaining({ code: 'low-cyrillic' }))
  })

  it('rejects a reply truncated at maxTokens so the engine retries', async () => {
    const dir = chaptersDir()
    const call = async () => ({
      content: '# Глава 1\n\nОборванная стр',
      model: 'm',
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: 'length',
    })
    const body = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const env = {
      ...createExchange(
        { text: '# Глава 1' },
        { variables: [variable('chapters', ['# Chapter 1\n\nA long enough line.'])] },
      ),
      items: [{ text: '# Глава 1' }],
    }
    await expect(body.invoke(env, ctx)).rejects.toBeInstanceOf(LlmError)
    await expect(body.invoke(env, ctx)).rejects.toMatchObject({ retryable: true })
  })

  it('loads an empty glossary only when the file is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-glossary-'))
    expect(await loadGlossaryOrEmpty(dir)).toEqual({ terms: [] })
  })

  it('throws on a malformed glossary instead of silently translating without terms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-glossary-'))
    writeFileSync(join(dir, 'glossary.json'), '{ not json')
    await expect(loadGlossaryOrEmpty(dir)).rejects.toThrow(/glossary\.json/)
  })
})
