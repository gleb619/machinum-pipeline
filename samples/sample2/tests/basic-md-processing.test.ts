import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

const RECORDS = [
  { id: 1, text: 'First line of the document.' },
  { id: 2, text: 'Second line of the document.' },
  { id: 3, text: 'Third line of the document.' },
]

const TYPED_RECORDS = [
  {
    id: 1,
    text: 'First paragraph of the document.\n\nSecond paragraph of the document.',
  },
]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, 'output-typed.md'), { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

async function writeInput(records: typeof RECORDS): Promise<void> {
  const jsonlContent = `${records.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await writeInput(RECORDS)
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
  return execSync(`"${MT_BIN}" run ./pipelines/basic-md-processing.ts${pipelineArg}`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    timeout: 10_000,
  }).toString('utf-8')
}

describe('default pipeline', () => {
  it('runs the default pipeline to completion', () => {
    run()
  })

  it('writes output.md with every input line', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'chapters', 'output.md'), 'utf-8')
    for (const record of RECORDS) {
      expect(content).toContain(record.text)
    }
  })

  it('counts the words of every line with the shipped wordCounter', () => {
    const stdout = run()
    const lines = stdout.match(/"stage":"basic"[^}]*}/g) ?? []
    expect(lines).toHaveLength(RECORDS.length)
    for (const line of lines) {
      expect(line).toMatch(/"wordCount":5/)
    }
  })
})

describe('statsPipeline', () => {
  it('runs to completion', () => {
    run('statsPipeline')
  })

  it('reports the corpus word statistics with the shipped statFreq', () => {
    const stdout = run('statsPipeline')
    // 3 records x 5 words = 15 words; 7 distinct words across the corpus.
    expect(stdout).toMatch(/"stage":"stats","totalWords":15,"uniqueWords":7/)
  })
})

describe('typedContentPipeline', () => {
  it('runs to completion', () => {
    run('typedContentPipeline')
  })

  it('writes output-typed.md with an edited heading and rewritten paragraph', async () => {
    await writeInput(TYPED_RECORDS)
    run('typedContentPipeline')
    const content = await readFile(join(SAMPLE_DIR, 'output-typed.md'), 'utf-8')
    expect(content).toMatch(/^# Edited: Line /m)
    expect(content).toContain('[REWRITTEN PARAGRAPH]')
  })
})
