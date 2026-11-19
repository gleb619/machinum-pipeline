import {
  BATCH_MEMBERS_VARIABLE,
  MD_OUTPUTS_VARIABLE,
  createExchange,
  getVariable,
  setVariable,
} from '@mt/core'
import type { MdOutputEntry, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  type ChapterMeasure,
  VAR_CHAPTER_STATS,
  bodyCharsOf,
  buildStats,
  chapterBodyOf,
  collectChapterStats,
  writeStats,
} from './chapter-stats.js'

const CHAPTER = '# Chapter 1: Salt Row\n\nArin walked in.\n'
const CTX = {} as ToolContext

function measure(n: number, bodyChars: number, words = 2, tokens = 3): ChapterMeasure {
  return { n, id: String(n), words, bodyChars, tokens }
}

describe('chapterBodyOf', () => {
  it('drops the leading H1 and keeps the rest verbatim', () => {
    expect(chapterBodyOf(CHAPTER)).toBe('\nArin walked in.\n')
    expect(chapterBodyOf('no heading\n')).toBe('no heading\n')
  })

  it('measures the body without the heading', () => {
    expect(bodyCharsOf(CHAPTER)).toBe(chapterBodyOf(CHAPTER).length)
  })
})

describe('buildStats', () => {
  it('sorts chapters and rounds every ratio to four decimals', () => {
    const artifact = buildStats([measure(2, 300, 4, 5), measure(1, 100, 2, 3)])
    expect(artifact.chapters.map((row) => row.n)).toEqual([1, 2])
    expect(artifact.book).toEqual({
      chapters: 2,
      totalWords: 6,
      totalTokens: 8,
      mean: 200,
      median: 200,
      threshold: 300,
    })
    expect(artifact.chapters[0]).toMatchObject({ ratioToMean: 0.5, oversize: false })
    expect(artifact.chapters[1]).toMatchObject({ ratioToMean: 1.5, oversize: false })
    expect(artifact.oversize).toEqual([])
  })

  it('marks a chapter above 1.5x the mean as oversize', () => {
    const artifact = buildStats([measure(1, 100), measure(2, 100), measure(3, 500)])
    expect(artifact.book.threshold).toBe(350)
    expect(artifact.oversize).toEqual([3])
  })

  it('is deterministic and handles an empty book', () => {
    expect(buildStats([])).toEqual({
      version: 1,
      unit: 'bodyChars',
      factor: 1.5,
      book: { chapters: 0, totalWords: 0, totalTokens: 0, mean: 0, median: 0, threshold: 0 },
      chapters: [],
      oversize: [],
    })
    expect(buildStats([measure(1, 120)])).toEqual(buildStats([measure(1, 120)]))
  })
})

describe('collectChapterStats', () => {
  it('uses the shipped word and token counts when they are present', async () => {
    let env = createExchange(CHAPTER, { meta: { chapterNum: 7 } })
    env = setVariable(env, 'wordCount', 42)
    env = setVariable(env, 'tokenCount', 11)
    const out = await collectChapterStats.invoke(env, CTX)
    expect(getVariable<ChapterMeasure>(out, VAR_CHAPTER_STATS)).toEqual({
      n: 7,
      id: '7',
      words: 42,
      bodyChars: bodyCharsOf(CHAPTER),
      tokens: 11,
    })
  })

  it('falls back to a whitespace count and zero tokens', async () => {
    const out = await collectChapterStats.invoke(
      createExchange(CHAPTER, { meta: { chapterNum: 2 } }),
      CTX,
    )
    expect(getVariable<ChapterMeasure>(out, VAR_CHAPTER_STATS)).toMatchObject({
      n: 2,
      words: CHAPTER.split(/\s+/).filter(Boolean).length,
      tokens: 0,
    })
  })
})

describe('writeStats', () => {
  it('emits one deterministic stats.json md output from the batch members', async () => {
    const members = [
      setVariable(createExchange(CHAPTER), VAR_CHAPTER_STATS, measure(2, 300)),
      setVariable(createExchange(CHAPTER), VAR_CHAPTER_STATS, measure(1, 100)),
    ]
    const batch = setVariable(
      createExchange<unknown[]>([CHAPTER, CHAPTER]),
      BATCH_MEMBERS_VARIABLE,
      {
        members,
        base: [],
      },
    )
    const out = await writeStats.invoke(batch, CTX)
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ name: 'stats', subdir: '', filename: 'stats.json' })
    const parsed = JSON.parse(outputs[0]?.content ?? '{}')
    expect(parsed.chapters.map((row: { n: number }) => row.n)).toEqual([1, 2])
    expect(outputs[0]?.content.endsWith('\n')).toBe(true)
  })

  it('emits an empty artifact when the batch has no measured members', async () => {
    const batch = setVariable(createExchange<unknown[]>([]), BATCH_MEMBERS_VARIABLE, {
      members: [],
      base: [],
    })
    const out = await writeStats.invoke(batch, CTX)
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(JSON.parse(outputs[0]?.content ?? '{}').book.chapters).toBe(0)
  })
})
