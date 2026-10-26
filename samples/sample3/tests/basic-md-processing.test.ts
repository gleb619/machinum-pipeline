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

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, 'events.jsonl'), { force: true })
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

describe('default pipeline', () => {
  it('runs the default pipeline to completion', () => {
    run()
  })

  it('writes output.md with each input line', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'output.md'), 'utf-8')
    for (const record of RECORDS) {
      expect(content).toContain(`- ${record.id}: ${record.text}`)
    }
  })

  it('applies both sync and async fork markers', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'output.md'), 'utf-8')
    for (const record of RECORDS) {
      expect(content).toContain(`- ${record.id}: ${record.text} [sync processed] [async processed]`)
    }
  })
})

describe('rangeDemoPipeline', () => {
  it('runs to completion', () => {
    run('rangeDemoPipeline')
  })

  it('emits a console event for each generated number', () => {
    const stdout = run('rangeDemoPipeline')
    expect(stdout).toMatch(/"type":"line-seen"/g)
    // range://1..3 produces three lines.
    expect(stdout.match(/"type":"line-seen"/g)?.length).toBe(3)
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

describe('eventsDemoPipeline + replayEventsPipeline', () => {
  it('captures lifecycle events to ./events.jsonl', () => {
    run('eventsDemoPipeline')
  })

  it('writes ./events.jsonl containing step-done and done events', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'events.jsonl'), 'utf-8')
    expect(content).toContain('"type":"step-done"')
    expect(content).toContain('"type":"done"')
  })

  it('replays captured events through the events-file source', () => {
    run('eventsDemoPipeline')
    const stdout = run('replayEventsPipeline')
    expect(stdout).toContain('[replay]')
    expect(stdout).toContain('"type":"step-done"')
  })
})

describe('countSidePipeline', () => {
  it('counts all input lines in a non-blocking side branch', () => {
    const stdout = run('countSidePipeline')
    expect(stdout).toContain('[counter] side branch counted 3 lines')
  })

  it('writes the counted batch to ./counts.jsonl', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'counts.jsonl'), 'utf-8')
    expect(content).toContain('"item":')
  })
})
