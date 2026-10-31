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

/** Words counted across the three lines ("1", "first", "line", "of", "the", "document" x3). */
const TOTAL_WORDS = RECORDS.length * 6

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, 'counts.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  const jsonlContent = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
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

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

describe('default pipeline', () => {
  it('runs the default pipeline to completion', () => {
    run()
  })

  it('writes output.md with every input line', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'output.md'), 'utf-8')
    for (const record of RECORDS) {
      expect(content).toContain(`${record.id}: ${record.text}`)
    }
  })

  it('runs the sync and async steps once per line', () => {
    const stdout = run()
    expect(countMatches(stdout, /"stage":"sync"/g)).toBe(RECORDS.length)
    expect(countMatches(stdout, /"stage":"async"/g)).toBe(RECORDS.length)
  })

  it('merges both fork branches back into the parent stream', () => {
    const stdout = run()
    const branches = stdout.match(/"stage":"branch"[^}]*}/g) ?? []
    expect(branches).toHaveLength(RECORDS.length)
    for (const branch of branches) {
      // tokenCount comes from the parallel tool step, statWords from the stats branch.
      expect(branch).toMatch(/"tokenCount":\d+/)
      expect(branch).toMatch(/"statWords":\d+/)
    }
  })

  it('counts the words of the whole corpus in the side stage', () => {
    const stdout = run()
    expect(stdout).toMatch(/"stage":"word-stats","totalWords":18,"uniqueWords":10/)
  })
})

describe('rangeDemoPipeline', () => {
  it('runs to completion', () => {
    run('rangeDemoPipeline')
  })

  it('processes every generated number', () => {
    const stdout = run('rangeDemoPipeline')
    expect(countMatches(stdout, /"stage":"range"/g)).toBe(3)
  })
})

describe('voidDemoPipeline', () => {
  it('runs to completion without creating output.md', async () => {
    await rm(join(SAMPLE_DIR, 'output.md'), { force: true })
    run('voidDemoPipeline')
    // void:// discards all writes; output.md should be absent.
    await expect(readFile(join(SAMPLE_DIR, 'output.md'), 'utf-8')).rejects.toThrow()
  })
})

describe('ephemeralDemoPipeline', () => {
  it('runs to completion using the built-in ephemeral:// target', () => {
    run('ephemeralDemoPipeline')
  })

  it('writes one envelope per input line into the in-memory buffer', () => {
    const stdout = run('ephemeralDemoPipeline')
    expect(countMatches(stdout, /"stage":"ephemeral"/g)).toBe(RECORDS.length)
  })
})

describe('countSidePipeline', () => {
  it('counts the corpus in a non-blocking side branch', () => {
    const stdout = run('countSidePipeline')
    expect(stdout).toContain(`"stage":"counter","totalWords":${TOTAL_WORDS}`)
  })

  it('writes the counted batch to ./counts.jsonl', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'counts.jsonl'), 'utf-8')
    expect(content).toContain('"name":"item"')
  })
})
