import { execSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fromPersisted } from '@mt/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const JSONL_DIR = join(SAMPLE_DIR, 'jsonl')
const LATCH_DIR = join(JSONL_DIR, 'latches')
const OUTPUT = join(JSONL_DIR, 'stop-resume.jsonl')
const RUNS_DIR = join(SAMPLE_DIR, '.mt', 'runs')
const STAGING_PREFIX = 'stop-resume.jsonl.tmp.'

let child: ReturnType<typeof spawn> | null = null
let hasFailure = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function cleanup(): Promise<void> {
  await rm(OUTPUT, { force: true })
  await rm(LATCH_DIR, { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
  const entries = await readdir(JSONL_DIR).catch(() => [] as string[])
  for (const name of entries.filter((entry) => entry.startsWith(STAGING_PREFIX))) {
    await rm(join(JSONL_DIR, name), { force: true })
  }
}

/** Resolve once item 1's line has reached the JSONL staging file. */
async function waitForStagedLine(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await readdir(JSONL_DIR).catch(() => [] as string[])
    const staged = entries.find((entry) => entry.startsWith(STAGING_PREFIX))
    if (staged) {
      const content = await readFile(join(JSONL_DIR, staged), 'utf-8')
      if (content.includes('\n')) return
    }
    await sleep(50)
  }
  throw new Error('timed out waiting for the first staged JSONL line')
}

/** Send SIGINT (the CLI's pause path) and wait for a clean exit. */
function pauseChild(proc: ReturnType<typeof spawn>): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
    proc.kill('SIGINT')
  })
}

async function singleRunId(): Promise<string> {
  const entries = await readdir(RUNS_DIR, { withFileTypes: true })
  const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const [runId] = runs
  if (runId === undefined || runs.length !== 1) {
    throw new Error(`expected exactly one run directory, found ${JSON.stringify(runs)}`)
  }
  return runId
}

async function readState(runId: string): Promise<{
  state: string
  checkpoint: { cursor?: unknown }
}> {
  return JSON.parse(await readFile(join(RUNS_DIR, runId, 'state.json'), 'utf-8'))
}

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  if (!hasFailure) await cleanup()
})

describe('stop / resume', () => {
  it('pauses on SIGINT, keeps committed output, and resume continues without duplicates', async () => {
    await cleanup()
    await mkdir(LATCH_DIR, { recursive: true })
    await writeFile(join(LATCH_DIR, '1.latch'), '')

    child = spawn(MT_BIN, ['run', './pipelines/stop-resume.ts'], {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', () => {})

    await waitForStagedLine(15_000)
    // Give the target's flush/counter a beat before the pause persists the cursor.
    await sleep(150)

    const exitCode = await pauseChild(child)
    child = null
    expect(exitCode, stderr).toBe(0)

    const runId = await singleRunId()
    const paused = await readState(runId)
    expect(paused.state).toBe('paused')
    expect(paused.checkpoint.cursor).toBe(1)

    for (const item of [2, 3, 4, 5]) {
      await writeFile(join(LATCH_DIR, `${item}.latch`), '')
    }

    execSync(`"${MT_BIN}" resume ${runId}`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 20_000,
    })

    const done = await readState(runId)
    expect(done.state).toBe('done')

    const lines = (await readFile(OUTPUT, 'utf-8')).trimEnd().split('\n')
    const items = lines.map((line) => fromPersisted<number>(JSON.parse(line)).item)
    expect(items).toEqual([1, 2, 3, 4, 5])
  }, 30_000)
})
