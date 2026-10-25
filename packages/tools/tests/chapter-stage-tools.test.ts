import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MdOutputEntry, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

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
  onlyChapters,
  titleOf,
  translateConcurrency,
  translateTaggedChapter,
} from '../src/normalization/translation-stage.js'
import { chapterPairsLinter } from '../src/verification/chapter-pairs-linter.js'

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
      { item: { key: 'k', value: 'Chapter 2: A\nl1\n\nl2' }, meta: {} },
      ctx,
    )
    expect(mapped.meta.chapterNum).toBe(2)
    const md = await lineTextToMarkdown.invoke(mapped, ctx)
    expect(md.item.text).toBe('# Chapter 2: A\n\nl1\n\nl2\n')
    const un = await unwrapMarkdownText.invoke(
      { item: { text: '\\[sys\\]' } as never, meta: {} },
      ctx,
    )
    expect(un.item).toBe('[sys]')
  })
})

describe('llm typo fix / summary', () => {
  it('keeps the original when the line count changes; pass-through when disabled', async () => {
    const bad = createLlmTypoFix({ call: reply('a\nb') })
    expect((await bad.invoke({ item: 'x', meta: {} }, ctx)).item).toBe('x')
    const good = createLlmTypoFix({ call: reply(' fixed ') })
    const out = await good.invoke({ item: 'x', meta: {} }, ctx)
    expect(out.item).toBe('fixed')
    expect(out.meta.llmFixed).toBe(true)
    const off = createLlmTypoFix({ call: reply('never'), enabled: false })
    expect((await off.invoke({ item: 'x', meta: {} }, ctx)).item).toBe('x')
  })

  it('summary tool passes through when disabled', async () => {
    const off = createLlmSummaryWithFallback({ call: reply('never'), enabled: false })
    const env = { item: 'x', meta: { summary: 'h' } }
    expect(await off.invoke(env, ctx)).toBe(env)
  })
})

describe('analyze / translate outputs', () => {
  const intents = (meta: Record<string, unknown>) => meta.mdOutputs as MdOutputEntry[]

  it('analyze outputs: summary + tagged per chapter and the glossary', async () => {
    const tool = createAnalyzeOutputs({ log: false })
    const res = await tool.invoke(
      {
        item: '',
        items: ['# Chapter 1: A\n\nHe ran.'],
        meta: { summaryByItem: ['S1'], taggedItems: ['# Chapter 1: A\n\nTAG'], glossaryJson: '{}' },
      },
      ctx,
    )
    const out = intents(res.meta)
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
        item: { en: '# Chapter 1: A', ru: '# Глава 1: А' },
        items: [{ en: '# Chapter 1: A', ru: '# Глава 1: А' }],
        meta: { chapterNums: [1], titlesRu: ['Глава 1: А'] },
      },
      ctx,
    )
    const out = intents(res.meta)
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
      { item: '' as never, items: ['# Chapter 1: A\nx', 'no heading'] as never, meta: {} },
      ctx,
    )
    expect(res.items?.map((i) => i.text)).toEqual(['# Chapter 1: A', '# Untitled'])
    expect(res.meta.chapters).toHaveLength(2)
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

  it('body translator + title translator + pairs linter work together', async () => {
    const dir = chaptersDir()
    const call = reply('Привет')
    const title = createGlossaryTitleTranslator({
      call: reply('Глава 1: Начало'),
      chaptersDir: dir,
    })
    const t = await title.invoke(
      { item: { text: '# Chapter 1: Start', targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(t.item.translatedText).toBe('Глава 1: Начало')

    const body = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const res = await body.invoke(
      {
        item: { text: '# Глава 1: Начало' },
        items: [{ text: '# Глава 1: Начало' }],
        meta: { chapters: ['# Chapter 1: Start\n\nHello there.'] },
      },
      ctx,
    )
    expect(res.meta.chapterNums).toEqual([1])
    expect(res.items?.[0]?.ru).toBe('# Глава 1: Начало\n\nПривет')
    const linted = await chapterPairsLinter.invoke(res as never, ctx)
    expect(linted.meta.parityByChapter).toEqual({ '1': { errors: 0, warnings: 0 } })
  })
})
