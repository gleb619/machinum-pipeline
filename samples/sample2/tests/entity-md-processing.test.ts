import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

const ENTITY_RECORDS = [
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

// 4 paragraphs, 5 lines, 22 words in the fixture above.
const EXPECTED = { paragraphs: 4, lines: 5, words: 22 }

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, 'counts.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'chapters-out'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'entities'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'entities'), { recursive: true })
  const content = `${ENTITY_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
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

function run(pipelineName?: string): string {
  const pipelineArg = pipelineName ? ` --pipeline ${pipelineName}` : ''
  return execSync(`"${MT_BIN}" run ./pipelines/entity-md-processing.ts${pipelineArg}`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    timeout: 20_000,
  }).toString('utf-8')
}

describe('entity pipeline (jsonl -> md -> paragraphs -> lines -> words)', () => {
  it('writes one markdown file per chapter', async () => {
    run()
    const chapter1 = await readFile(join(SAMPLE_DIR, 'chapters-out', 'chapter1.md'), 'utf-8')
    const chapter2 = await readFile(join(SAMPLE_DIR, 'chapters-out', 'chapter2.md'), 'utf-8')

    expect(chapter1).toContain('# Chapter One')
    expect(chapter1).toContain('The first line has words.')
    expect(chapter1).toContain('A short paragraph ends.')
    expect(chapter2).toContain('# Chapter Two')
    expect(chapter2).toContain('Final line closes the book.')
  })

  it('fans out every entity level and reports the counts', () => {
    const stdout = run()
    expect(stdout).toContain(`[entities] paragraphs=${EXPECTED.paragraphs}`)
    expect(stdout).toContain(`[entities] lines=${EXPECTED.lines}`)
    expect(stdout).toContain(`[entities] words=${EXPECTED.words}`)
  })

  it('writes one persisted Word entity per JSONL line', async () => {
    run()
    const raw = await readFile(join(SAMPLE_DIR, 'entities', 'words.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(EXPECTED.words)
    expect(raw).toContain('"word":"first"')
    expect(raw).toContain('"lineId":"chapter-1/paragraph-1/line-1"')
  })
})

describe('parallelBranchesPipeline', () => {
  it('runs two forks per paragraph and overlaps the parallel tool step', () => {
    const stdout = run('parallelBranchesPipeline')

    expect(stdout.match(/\[branch\] sync=/g)).toHaveLength(EXPECTED.paragraphs)
    expect(stdout.match(/\[branch\] async=/g)).toHaveLength(EXPECTED.paragraphs)

    const probes = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map(
        (line) => JSON.parse(line) as { probe?: string; id?: string; start?: number; end?: number },
      )
      .filter((entry) => entry.probe === 'parallel')

    expect(probes).toHaveLength(EXPECTED.paragraphs)
    const overlaps = probes.some((a, i) =>
      probes.some(
        (b, j) => i !== j && (a.start ?? 0) < (b.end ?? 0) && (b.start ?? 0) < (a.end ?? 0),
      ),
    )
    expect(overlaps).toBe(true)
  })
})
