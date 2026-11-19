import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { assertSummaryIsShort, summaryBullets, writeSummaries } from '@mt/tools'
import { chapterBodyOf } from '@mt/tools'
import { createSummaryTool } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21
let hasFailure = false
const summaries = new Map<number, string>()

async function cleanSummaries(): Promise<void> {
  const names = await readdir(SCHEMA_DIR).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => /^chapter\d+\.summary\.md$/.test(name))
      .map((name) => rm(join(SCHEMA_DIR, name), { force: true })),
  )
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

beforeAll(async () => {
  await cleanSummaries()
  await clean(join(SAMPLE_DIR, '.mt'))
  run('preparation.ts', { pipeline: 'summary', timeout: 240_000 })
  const files = (await readdir(SCHEMA_DIR)).filter((file) => /^chapter\d+\.summary\.md$/.test(file))
  for (const file of files) {
    const number = Number.parseInt(file.slice('chapter'.length), 10)
    summaries.set(number, await readFile(join(SCHEMA_DIR, file), 'utf-8'))
  }
}, 240_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanSummaries()
})

describe('summary', () => {
  it('writes one summary per chapter', () => {
    expect([...summaries.keys()].sort((left, right) => left - right)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1),
    )
  })

  it('keeps the chapter title, a Summary section and dash bullets', () => {
    const summary = summaries.get(1) ?? ''
    expect(summary).toContain('# Chapter 1: The Donation')
    expect(summary).toContain('## Summary')
    expect(summary.length).toBeGreaterThan(100)
    const block = summary.split('## Summary')[1]?.trim() ?? ''
    expect(block.length).toBeGreaterThan(0)
    for (const line of block.split('\n').filter((line) => line.trim() !== '')) {
      expect(line.startsWith('- ')).toBe(true)
    }
  })

  it('summarises every chapter differently and at most 25 % of its body', async () => {
    const blocks = new Set<string>()
    for (const [number, summary] of summaries) {
      const block = (summary.split('## Summary')[1] ?? '').trim()
      const text = block.replace(/^-\s+/gm, '')
      expect(text.length).toBeGreaterThan(0)
      blocks.add(text)

      const markdown = await readFile(join(BOOK_DIR, `chapter-${number}.en.md`), 'utf-8')
      const bodyWords = words(chapterBodyOf(markdown))
      const summaryWords = words(text)
      expect(summaryWords, `chapter ${number}`).toBeLessThanOrEqual(bodyWords * 0.25)
    }
    expect(blocks.size).toBe(CHAPTER_COUNT)
  })
})

describe('real-model reply shape', () => {
  /** The shape the free model returned: the default prompt's `- ` bullets, nothing else. */
  const BULLET_REPLY = [
    '- Fiona Doyle brings four boxes from Cormac Doyle’s office to the Fenwick Street archive.',
    '- Nadia and Gus Pemberton process the donation in the basement of the Carnegie library.',
    '- The boxes hold harbor papers, tide tables, invoices and tapes.',
    '- Nadia finds a rusted biscuit tin with a quarter-inch reel at the bottom of the third box.',
    '- The label is in her dead brother’s handwriting: KSTL 3/3/14, a weather log.',
    '- Her brother drowned twelve years earlier when the Pelargic was found empty off Kestrel Point.',
    '- Nadia hides the reel and does not enter it in the accession register.',
  ].join('\n')

  it('turns a bullet-only reply into a short, bullet-formed summary file', async () => {
    const markdown = await readFile(join(BOOK_DIR, 'chapter-1.en.md'), 'utf-8')
    const tool = createSummaryTool({
      call: async () => ({
        content: BULLET_REPLY,
        model: 'mock',
        tokens: 5,
        promptTokens: 3,
        completionTokens: 2,
      }),
    })
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const summarized = await tool.invoke(
      { id: 'summary-reply-shape', item: markdown, meta: {}, variables: [] } as never,
      ctx,
    )
    expect(getVariable(summarized, 'summaryLlm')).toMatchObject({
      attempts: 1,
      fallbackUsed: false,
    })

    const emitted = await writeSummaries.invoke(summarized, ctx)
    const outputs = getVariable<{ filename: string; content: string }[]>(emitted, 'mdOutputs') ?? []
    const file = outputs.find((entry) => entry.filename === 'chapter1.summary.md')
    expect(file).toBeDefined()

    const block = (file?.content ?? '').split('## Summary')[1]?.trim() ?? ''
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.startsWith('- ')).toBe(true)

    const bodyWords = words(chapterBodyOf(markdown))
    expect(words(block)).toBeLessThanOrEqual(bodyWords * 0.25)
    expect(block).not.toContain('The rain came off the bay all morning')
  })
})

describe('R6 summary guard', () => {
  const markdown = `# Chapter 9: Test\n\n${Array.from({ length: 80 }, () => 'word').join(' ')}`

  it('fails an empty summary and names the chapter', () => {
    expect(() => assertSummaryIsShort(9, 'Chapter 9: Test', '', markdown)).toThrow(
      /chapter 9.*empty/i,
    )
  })

  it('fails a whole-chapter copy', () => {
    const wholeChapter = Array.from({ length: 60 }, () => 'word').join(' ')
    expect(() => assertSummaryIsShort(9, 'Chapter 9: Test', wholeChapter, markdown)).toThrow(
      /chapter 9.*25 %/i,
    )
  })

  it('keeps a single sentence as one bullet', () => {
    expect(summaryBullets('The archive keeps one recovered tape.')).toEqual([
      '- The archive keeps one recovered tape.',
    ])
  })
})
