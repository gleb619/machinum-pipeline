import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const OUTPUT = join(SAMPLE_DIR, 'chapters', 'parallel-forks.md')

const RECORDS = [
  {
    number: 1,
    title: 'Chapter One',
    paragraphs: [
      ['The first line has words.', 'Second line follows here.'],
      ['A short paragraph ends.'],
    ],
  },
  {
    number: 2,
    title: 'Chapter Two',
    paragraphs: [['Third chapter starts now.'], ['Final line closes the book.']],
  },
]

interface ForkEvent {
  stage?: string
  name?: string
  phase?: 'start' | 'done'
  chapterId?: string
  at?: number
}

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), { force: true })
  await rm(OUTPUT, { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  const content = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), content, 'utf-8')
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

function run(): string {
  return execSync(`"${MT_BIN}" run ./pipelines/parallel-forks-md-processing.ts`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    timeout: 10_000,
  }).toString('utf-8')
}

function forkEvents(stdout: string): ForkEvent[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as ForkEvent)
    .filter((event) => event.stage === 'fork')
}

describe('parallel forks pipeline', () => {
  it('writes counts, reordered lines and comma-replaced dots to markdown', async () => {
    run()
    const content = await readFile(OUTPUT, 'utf-8')

    expect(content).toContain('# Chapter One')
    expect(content).toContain('2 paragraphs · 3 lines · 13 words')
    expect(content).toContain('# Chapter Two')
    expect(content).toContain('2 paragraphs · 2 lines · 9 words')

    expect(content).toContain('- Second line follows here,\n- The first line has words,')
    expect(content).toContain('- A short paragraph ends,')
    expect(content).toContain('- Final line closes the book,')
    expect(content).not.toContain('.')
  })

  it('runs the three branches concurrently for every chapter', () => {
    const events = forkEvents(run())
    for (const chapterId of ['chapter-1', 'chapter-2']) {
      const chapterEvents = events.filter((event) => event.chapterId === chapterId)
      const starts = chapterEvents
        .filter((event) => event.phase === 'start')
        .map((event) => event.at ?? 0)
      const dones = chapterEvents
        .filter((event) => event.phase === 'done')
        .map((event) => event.at ?? 0)

      expect(starts).toHaveLength(3)
      expect(dones).toHaveLength(3)
      expect(Math.max(...starts)).toBeLessThan(Math.min(...dones))
      expect(new Set(chapterEvents.map((event) => event.name))).toEqual(
        new Set(['count-paragraphs', 'reorder-lines', 'dots-to-commas']),
      )
    }
  })
})
