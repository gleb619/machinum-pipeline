import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const EN_DIR = join(SAMPLE_DIR, 'chapters', 'en')
const LOG_PATH = join(SAMPLE_DIR, 'chapters', 'waypoint-log.jsonl')

// Same shape as normalize.test.ts + one EMPTY chapter: the source-wrapper filter must drop it.
const RAW = [
  {
    key: 'fixture/chapter-1',
    value: 'Chapter 1: First Light\n“Hello,” she said… it’s fine .\n[System: level up!]',
  },
  {
    key: 'fixture/chapter-2',
    value: 'Chapter 2: Second Wind\nOne – two—three.',
  },
  // An EMPTY record (no value at all): the source-wrapper filter drops it before any tool runs.
  { key: 'fixture/chapter-3', value: '' },
]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(LOG_PATH, { force: true })
  await mkdir(EN_DIR, { recursive: true })
  for (const f of await readdir(EN_DIR)) {
    if (f.endsWith('.md')) await rm(join(EN_DIR, f), { force: true })
  }
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  const jsonl = `${RAW.map((item) => JSON.stringify({ item })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonl, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('waypoint-log pipeline (defineWaypoint lifecycle audit log)', () => {
  it('runs to completion', () => {
    execSync(`"${MT_BIN}" run ./pipelines/waypoint-log.ts`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx', MT_LLM_TYPO_FIX: '' },
      timeout: 20_000,
    })
  })

  it('writes one md per non-empty chapter (the empty one is filtered out)', async () => {
    const files = (await readdir(EN_DIR)).filter((f) => f.endsWith('.md')).sort()
    expect(files).toEqual(['chapter1.md', 'chapter2.md'])
  })

  it('writes the audit log with the lifecycle event sequence', async () => {
    const lines = (await readFile(LOG_PATH, 'utf-8')).trim().split('\n').filter(Boolean)
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event)

    expect(events.filter((e) => e === 'source:start')).toHaveLength(1)
    expect(events.filter((e) => e === 'source:item')).toHaveLength(2)
    expect(events.filter((e) => e === 'source:skip')).toHaveLength(1)
    expect(events.filter((e) => e === 'target:open')).toHaveLength(1)
    expect(events.filter((e) => e === 'target:write')).toHaveLength(2)
    expect(events.filter((e) => e === 'target:close')).toHaveLength(1)
    // close (which flushes the log) is always the last event
    expect(events.at(-1)).toBe('target:close')
  })

  it('skips the empty chapter and logs its key', async () => {
    const lines = (await readFile(LOG_PATH, 'utf-8')).trim().split('\n')
    const skip = lines
      .map((l) => JSON.parse(l) as { event: string; key?: string })
      .find((e) => e.event === 'source:skip')
    expect(skip?.key).toBe('fixture/chapter-3')
  })
})
