import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tokenizeChunk, tokenizeWords } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, logs, run, runScript, writeJsonl } from './helpers.js'

const CHAPTER = join(SAMPLE_DIR, 'fixtures', 'chapter1.md')
const CHUNKED = join(CHAPTERS, 'chunked.md')
const CHUNKED_REUSED = join(CHAPTERS, 'chunked-reused.md')
const LADDER_CHAPTERS = join(CHAPTERS, 'ladder-chapters')
const LADDER_SUMMARY = join(CHAPTERS, 'ladder-summary.md')
const TOKEN_SUMMARY = join(CHAPTERS, 'token-ladder-summary.md')
const SERIES_FIRST_OUTPUT = join(CHAPTERS, 'series-first-output.md')
const TREE_MUTATED = join(CHAPTERS, 'tree-mutated.md')
const LADDER_JSONL = join(SAMPLE_DIR, 'jsonl', 'ladder.jsonl')
const SERIES_TARGET_CHARS = 150

const LADDER_RECORDS = [
  {
    number: 1,
    title: 'Ladder Chapter One',
    paragraphs: [
      ['The ladder starts with one markdown document.'],
      [
        'Every rung below the document is one envelope per unit of the level above it. Chunks become paragraphs, paragraphs become lines, and lines become words.',
        'A chunk never crosses a paragraph boundary, so the text of a paragraph always stays readable on its own.',
      ],
    ],
  },
  {
    number: 2,
    title: 'Ladder Chapter Two',
    paragraphs: [
      [
        'A second document shows that the ladder handles more than one chapter.',
        'Each chapter brings its own chunks, paragraphs, lines and words.',
      ],
    ],
  },
]

const LADDER_LINES = LADDER_RECORDS.flatMap((record) => record.paragraphs).flat()
const LADDER_WORDS = LADDER_LINES.reduce((sum, line) => sum + tokenizeWords(line).length, 0)

let hasFailure = false

async function cleanupLadderChapters(): Promise<void> {
  const entries = await readdir(LADDER_CHAPTERS).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((name) => /^chapter\d+\.md$/.test(name))
      .map((name) => rm(join(LADDER_CHAPTERS, name), { force: true })),
  )
}

async function cleanup(): Promise<void> {
  await clean(
    CHUNKED,
    CHUNKED_REUSED,
    LADDER_SUMMARY,
    TOKEN_SUMMARY,
    SERIES_FIRST_OUTPUT,
    TREE_MUTATED,
    join(SAMPLE_DIR, '.mt'),
  )
  await cleanupLadderChapters()
}

beforeAll(async () => {
  await cleanup()
  runScript('prepare-input.ts')
  await writeJsonl(LADDER_JSONL, LADDER_RECORDS)
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

function runAdvanced(pipeline?: string): string {
  return run('pipe05-chunks-ladder.ts', {
    ...(pipeline ? { pipeline } : {}),
    env: {
      MT_CHUNK_SIZE: '40',
      MT_CONST_SERIES_SPLIT_TARGET_CHARS: String(SERIES_TARGET_CHARS),
    },
  })
}

function events(stdout: string): Array<{ stage?: string; chunkCount?: number; reused?: boolean }> {
  return logs(stdout).filter((entry) => typeof entry.stage === 'string') as Array<{
    stage?: string
    chunkCount?: number
    reused?: boolean
  }>
}

function ladderLog(stdout: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of stdout.matchAll(/\[ladder\] (\w+)=(\d+)/g)) {
    counts.set(match[1] as string, Number(match[2]))
  }
  return counts
}

function summaryRows(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of content.matchAll(/^\|\s*\d\s*\|\s*(\S+)\s*\|\s*(\d+)\s*\|$/gm)) {
    counts.set(match[1] as string, Number(match[2]))
  }
  return counts
}

const countLines = (content: string, text: string) =>
  content.split('\n').filter((line) => line.trim() === text).length

describe('pipe05 clean split and separator reuse', () => {
  it('writes the chapter back as chunks separated by ---', async () => {
    runAdvanced()
    const content = await readFile(CHUNKED, 'utf-8')
    expect(content).toContain('---')
    expect(content).toContain('The Structure Ladder')
    expect(await readFile(SERIES_FIRST_OUTPUT, 'utf-8')).toContain('The Long Road')
  })

  it('reports the chunk count and leaves only chunk text in the file', async () => {
    const stdout = runAdvanced()
    const split = events(stdout).find((entry) => entry.stage === 'clean-split')
    const chunkCount = Number(split?.chunkCount)
    expect(chunkCount).toBeGreaterThan(1)

    const content = await readFile(CHUNKED, 'utf-8')
    expect(content).not.toContain('chunkCount')
    expect(content.startsWith('# The Structure Ladder')).toBe(true)
    expect(countLines(content, '---')).toBe(chunkCount - 1)
  })

  it('cleans the decorative separator lines of the source chapter', async () => {
    const chapter = await readFile(CHAPTER, 'utf-8')
    const decorative = countLines(chapter, '---')
    expect(decorative).toBeGreaterThan(0)

    const stdout = runAdvanced()
    const chunkCount = Number(
      events(stdout).find((entry) => entry.stage === 'clean-split')?.chunkCount,
    )
    const content = await readFile(CHUNKED, 'utf-8')
    expect(countLines(content, '---')).toBe(chunkCount - 1)
    expect(countLines(content, '---')).toBeLessThan(decorative + chunkCount - 1)
  })

  it('reuses the separators on a second run: the chunks stay the same', async () => {
    const stdout = runAdvanced()
    const split = events(stdout).find((entry) => entry.stage === 'clean-split')
    const reuse = events(stdout).find((entry) => entry.stage === 'reuse')
    expect(Number(reuse?.chunkCount)).toBe(Number(split?.chunkCount))
    expect(reuse?.reused).toBe(true)
    expect((await readFile(CHUNKED_REUSED, 'utf-8')).trimEnd()).toBe(
      (await readFile(CHUNKED, 'utf-8')).trimEnd(),
    )
  })
})

describe('pipe05 structure ladder', () => {
  it('writes one document per ladder record', async () => {
    runAdvanced('ladderPipeline')
    expect(await readFile(join(LADDER_CHAPTERS, 'chapter1.md'), 'utf-8')).toContain(
      'Ladder Chapter One',
    )
    expect(await readFile(join(LADDER_CHAPTERS, 'chapter2.md'), 'utf-8')).toContain(
      'Ladder Chapter Two',
    )
  })

  it('writes a summary with one row per rung and consistent counts', async () => {
    const stdout = runAdvanced('ladderPipeline')
    const content = await readFile(LADDER_SUMMARY, 'utf-8')
    const rows = summaryRows(content)
    const logged = ladderLog(stdout)
    expect([...rows.keys()]).toEqual([
      'jsonl://',
      'md://',
      'chunks://',
      'paragraphs://',
      'lines://',
      'words://',
    ])
    expect(rows.get('jsonl://')).toBe(LADDER_RECORDS.length)
    expect(rows.get('md://')).toBe(LADDER_RECORDS.length)
    expect(rows.get('chunks://')).toBeGreaterThan(LADDER_RECORDS.length)
    expect(rows.get('paragraphs://')).toBeGreaterThanOrEqual(Number(rows.get('chunks://')))
    expect(rows.get('lines://')).toBe(LADDER_LINES.length)
    expect(rows.get('words://')).toBe(LADDER_WORDS)
    expect(logged.get('documents')).toBe(rows.get('md://'))
    expect(logged.get('chunks')).toBe(rows.get('chunks://'))
    expect(logged.get('paragraphs')).toBe(rows.get('paragraphs://'))
    expect(logged.get('lines')).toBe(rows.get('lines://'))
    expect(logged.get('words')).toBe(rows.get('words://'))
    expect(content).toContain(`Words in the last rung: ${LADDER_WORDS}`)
  })

  it('edits a line inside the first chunk and keeps chunk separators', async () => {
    runAdvanced('treeMutationPipeline')
    const content = await readFile(TREE_MUTATED, 'utf-8')
    expect(content).toContain('[tree-edit]')
    expect(content).toContain('---')
    expect(content).toContain('The Structure Ladder')
  })
})

describe('pipe05 token ladder', () => {
  it('writes chunk and token counts for the alternate route', async () => {
    const stdout = runAdvanced('tokenLadderPipeline')
    const content = await readFile(TOKEN_SUMMARY, 'utf-8')
    const logged = ladderLog(stdout)
    const chunks = Number(/\| 2 \| chunks:\/\/ \| (\d+) \|/.exec(content)?.[1])
    const tokens = Number(/\| alt \| tokens:\/\/ \| (\d+) \|/.exec(content)?.[1])
    expect(chunks).toBeGreaterThan(LADDER_RECORDS.length)
    expect(tokens).toBeGreaterThan(chunks)
    expect(logged.get('chunks')).toBe(chunks)
    expect(logged.get('tokens')).toBe(tokens)
    expect(content).toContain(`Tokens in the last rung: ${tokens}`)
  })

  it('never yields fewer tokens than the whole text minus join whitespace', async () => {
    runAdvanced('tokenLadderPipeline')
    const content = await readFile(TOKEN_SUMMARY, 'utf-8')
    const tokens = Number(/\| alt \| tokens:\/\/ \| (\d+) \|/.exec(content)?.[1])
    const whole = (await tokenizeChunk(LADDER_LINES.join(' '))).length
    expect(tokens).toBeGreaterThanOrEqual(whole - LADDER_LINES.length)
  })
})
