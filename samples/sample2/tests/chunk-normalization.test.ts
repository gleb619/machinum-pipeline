import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tokenizeChunk, tokenizeWords } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const CHAPTER = join(SAMPLE_DIR, 'chapters', 'chapter1.md')
const CHUNKED = join(SAMPLE_DIR, 'out', 'chunked.md')
const CHUNKED_REUSED = join(SAMPLE_DIR, 'out', 'chunked-reused.md')
const LADDER_SUMMARY = join(SAMPLE_DIR, 'out', 'ladder-summary.md')
const TOKEN_SUMMARY = join(SAMPLE_DIR, 'out', 'token-ladder-summary.md')

/** Chapter fixture of the Structure Ladder demo (same file as `prepare-input.ts`). */
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

/** All lines of the ladder fixture. */
const LADDER_LINES = LADDER_RECORDS.flatMap((record) => record.paragraphs).flat()

/** Words of the ladder fixture — the last rung of the ladder counts them. */
const LADDER_WORDS = LADDER_LINES.reduce((sum, line) => sum + tokenizeWords(line).length, 0)

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'ladder.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'out'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  const content = `${LADDER_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'ladder.jsonl'), content, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (!hasFailure) {
    await cleanup()
  }
})

function run(pipelineName?: string): string {
  const pipelineArg = pipelineName ? ` --pipeline ${pipelineName}` : ''
  return execSync(`"${MT_BIN}" run ./pipelines/chunk-normalization.ts${pipelineArg}`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    // The demo chunk size of the sample, pinned so the run does not depend on
    // the shell of the developer.
    env: { ...process.env, NODE_OPTIONS: '--import tsx', MT_CHUNK_SIZE: '40' },
    timeout: 20_000,
  }).toString('utf-8')
}

/** The JSON lines the pipeline logs. */
function events(stdout: string): { stage?: string; chunkCount?: number; reused?: boolean }[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { stage?: string; chunkCount?: number; reused?: boolean })
}

/** The `[ladder] <rung>=<count>` lines the counting waypoints log. */
function ladderLog(stdout: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of stdout.matchAll(/\[ladder\] (\w+)=(\d+)/g)) {
    counts.set(match[1] as string, Number(match[2]))
  }
  return counts
}

/** The `| rung | scheme | units |` rows of the ladder summary. */
function summaryRows(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of content.matchAll(/^\|\s*\d\s*\|\s*(\S+)\s*\|\s*(\d+)\s*\|$/gm)) {
    counts.set(match[1] as string, Number(match[2]))
  }
  return counts
}

/** Number of lines that are exactly `text`. */
function countLines(content: string, text: string): number {
  return content.split('\n').filter((line) => line.trim() === text).length
}

describe('cleanSplitPipeline', () => {
  it('writes the chapter back as chunks separated by ---', async () => {
    run()
    const content = await readFile(CHUNKED, 'utf-8')
    expect(content).toContain('---')
    expect(content).toContain('The Structure Ladder')
  })

  it('records the chunk count in the exchange meta and in the file header', async () => {
    const stdout = run()
    const split = events(stdout).find((entry) => entry.stage === 'clean-split')
    const chunkCount = Number(split?.chunkCount)
    expect(chunkCount).toBeGreaterThan(1)

    const content = await readFile(CHUNKED, 'utf-8')
    expect(content.startsWith(`<!-- chunkCount: ${chunkCount} -->`)).toBe(true)
    // Every separator line in the output is a chunk separator — nothing else.
    expect(countLines(content, '---')).toBe(chunkCount - 1)
  })

  it('cleans the decorative separator lines of the source chapter', async () => {
    const chapter = await readFile(CHAPTER, 'utf-8')
    const decorative = countLines(chapter, '---')
    expect(decorative).toBeGreaterThan(0)

    const stdout = run()
    const chunkCount = Number(events(stdout).find((e) => e.stage === 'clean-split')?.chunkCount)
    const content = await readFile(CHUNKED, 'utf-8')
    expect(countLines(content, '---')).toBe(chunkCount - 1)
    expect(countLines(content, '---')).toBeLessThan(decorative + chunkCount - 1)
  })

  it('reuses the separators on a second run: the chunks stay the same', async () => {
    const stdout = run()
    const counts = events(stdout).filter((entry) => entry.stage !== undefined)
    const split = counts.find((entry) => entry.stage === 'clean-split')
    const reuse = counts.find((entry) => entry.stage === 'reuse')
    expect(Number(reuse?.chunkCount)).toBe(Number(split?.chunkCount))
    expect(reuse?.reused).toBe(true)

    const first = await readFile(CHUNKED, 'utf-8')
    const second = await readFile(CHUNKED_REUSED, 'utf-8')
    expect(second).toBe(first)
  })
})

describe('ladderPipeline', () => {
  it('writes a summary with one row per rung', async () => {
    run('ladderPipeline')
    const content = await readFile(LADDER_SUMMARY, 'utf-8')
    const rows = summaryRows(content)
    expect([...rows.keys()]).toEqual([
      'jsonl://',
      'md://',
      'chunks://',
      'paragraphs://',
      'lines://',
      'words://',
    ])
  })

  it('counts every rung consistently', async () => {
    const stdout = run('ladderPipeline')
    const content = await readFile(LADDER_SUMMARY, 'utf-8')
    const rows = summaryRows(content)
    const logged = ladderLog(stdout)

    expect(rows.get('jsonl://')).toBe(LADDER_RECORDS.length)
    expect(rows.get('md://')).toBe(LADDER_RECORDS.length)
    // The long paragraph of chapter one is longer than the chunk budget, so the
    // documents split into more chunks than there are documents.
    expect(rows.get('chunks://')).toBeGreaterThan(LADDER_RECORDS.length)
    // Every chunk holds at least one paragraph.
    expect(rows.get('paragraphs://')).toBeGreaterThanOrEqual(Number(rows.get('chunks://')))
    expect(rows.get('lines://')).toBe(LADDER_LINES.length)
    expect(rows.get('words://')).toBe(LADDER_WORDS)

    // The summary and the log of the run agree on every rung.
    expect(logged.get('documents')).toBe(rows.get('md://'))
    expect(logged.get('chunks')).toBe(rows.get('chunks://'))
    expect(logged.get('paragraphs')).toBe(rows.get('paragraphs://'))
    expect(logged.get('lines')).toBe(rows.get('lines://'))
    expect(logged.get('words')).toBe(rows.get('words://'))
    expect(content).toContain(`Words in the last rung: ${LADDER_WORDS}`)
  })
})

describe('tokenLadderPipeline', () => {
  it('writes chunk and token counts for the alternate route', async () => {
    const stdout = run('tokenLadderPipeline')
    const content = await readFile(TOKEN_SUMMARY, 'utf-8')
    const logged = ladderLog(stdout)

    const chunks = Number(/\| 2 \| chunks:\/\/ \| (\d+) \|/.exec(content)?.[1])
    const tokens = Number(/\| alt \| tokens:\/\/ \| (\d+) \|/.exec(content)?.[1])
    expect(chunks).toBeGreaterThan(LADDER_RECORDS.length)
    expect(tokens).toBeGreaterThan(chunks)
    expect(logged.get('chunks')).toBe(chunks)
    expect(logged.get('tokens')).toBe(tokens)
    expect(content).toContain(`Tokens in the last rung: ${tokens}`)
    expect(content).toContain('Heuristic: false')
  })

  it('token count is at least the BPE count of the whole text split by chunk', async () => {
    run('tokenLadderPipeline')
    const content = await readFile(TOKEN_SUMMARY, 'utf-8')
    const tokens = Number(/\| alt \| tokens:\/\/ \| (\d+) \|/.exec(content)?.[1])
    const text = LADDER_LINES.join(' ')
    const whole = (await tokenizeChunk(text)).length
    // Chunking only adds boundaries, so it never yields fewer tokens than the whole text
    // minus the join whitespace; allow a small slack for newline vs space.
    expect(tokens).toBeGreaterThanOrEqual(whole - LADDER_LINES.length)
  })
})
