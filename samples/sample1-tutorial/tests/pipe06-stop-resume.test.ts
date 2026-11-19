import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fromPersisted } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_ENV, MT_BIN, SAMPLE_DIR } from './helpers.js'

const PIPELINE = join(SAMPLE_DIR, 'pipelines', 'pipe06-stop-resume.ts')
const STAGING_PREFIX = 'stop-resume.jsonl.tmp.'

// Each test file gets a private project root under the sample: the pipeline's relative URIs
// and `.mt/` state stay isolated from other samples/agents sharing `samples/sample1-tutorial`.
let WORK_ROOT = ''
let JSONL_DIR = ''
let LATCH_DIR = ''
let OUTPUT = ''
let RUNS_DIR = ''

let child: ReturnType<typeof spawn> | null = null

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))

async function cleanup(): Promise<void> {
  await rm(WORK_ROOT, { recursive: true, force: true })
  await mkdir(WORK_ROOT, { recursive: true })
}

async function listRuns(): Promise<string[]> {
  const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

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

/** Find the single run of `pipelineId` inside the private work root. */
async function findRunId(pipelineId: string): Promise<string> {
  const runs = await listRuns()
  const found: string[] = []
  for (const runId of runs) {
    const state = await readState(runId).catch(() => undefined)
    if (state?.pipelineId === pipelineId) found.push(runId)
  }
  const [runId] = found
  if (runId === undefined || found.length !== 1) {
    throw new Error(`expected one '${pipelineId}' run, found ${JSON.stringify(found)}`)
  }
  return runId
}

async function readState(runId: string): Promise<{
  pipelineId: string
  state: string
  checkpoint: { cursor?: unknown }
}> {
  return JSON.parse(await readFile(join(RUNS_DIR, runId, 'state.json'), 'utf-8'))
}

beforeAll(async () => {
  WORK_ROOT = await mkdtemp(join(SAMPLE_DIR, 'tmp-pipe06-'))
  JSONL_DIR = join(WORK_ROOT, 'jsonl')
  LATCH_DIR = join(JSONL_DIR, 'latches')
  OUTPUT = join(JSONL_DIR, 'stop-resume.jsonl')
  RUNS_DIR = join(WORK_ROOT, '.mt', 'runs')
})

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('pipe06 stop / resume', () => {
  it('pauses on SIGINT, keeps committed output, and resume continues without duplicates', async () => {
    await cleanup()
    await mkdir(LATCH_DIR, { recursive: true })
    await writeFile(join(LATCH_DIR, '1.latch'), '')

    child = spawn(MT_BIN, ['run', PIPELINE], {
      cwd: WORK_ROOT,
      stdio: 'pipe',
      env: BASE_ENV,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', () => {})

    await waitForStagedLine(15_000)
    await sleep(150)

    const exitCode = await pauseChild(child)
    child = null
    expect(exitCode, stderr).toBe(0)

    const runId = await findRunId('pipe06-stop-resume')
    const paused = await readState(runId)
    expect(paused.state).toBe('paused')
    expect(paused.checkpoint.cursor).toBe(1)

    for (const item of [2, 3, 4, 5]) {
      await writeFile(join(LATCH_DIR, `${item}.latch`), '')
    }

    execFileSync(MT_BIN, ['resume', runId], {
      cwd: WORK_ROOT,
      stdio: 'pipe',
      env: BASE_ENV,
      timeout: 20_000,
    })

    expect((await readState(runId)).state).toBe('done')
    const lines = (await readFile(OUTPUT, 'utf-8')).trimEnd().split('\n')
    const items = lines.map((line) => fromPersisted<number>(JSON.parse(line)).item)
    expect(items).toEqual([1, 2, 3, 4, 5])
  }, 30_000)

  it('lifecycle suite logs started/paused via events:// and resume finishes the work run', async () => {
    await cleanup()
    await mkdir(LATCH_DIR, { recursive: true })
    await writeFile(join(LATCH_DIR, '1.latch'), '')

    child = spawn(MT_BIN, ['run', PIPELINE, '--pipeline', 'stopResumeLifecycleSuite'], {
      cwd: WORK_ROOT,
      stdio: 'pipe',
      env: BASE_ENV,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    await waitForStagedLine(15_000)
    await sleep(150)

    const exitCode = await pauseChild(child)
    child = null
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('[lifecycle] started')
    expect(stdout).toContain('[lifecycle] paused')

    const runId = await findRunId('pipe06-stop-resume')
    const paused = await readState(runId)
    expect(paused.state).toBe('paused')
    expect(paused.checkpoint.cursor).toBe(1)

    for (const item of [2, 3, 4, 5]) {
      await writeFile(join(LATCH_DIR, `${item}.latch`), '')
    }

    execFileSync(MT_BIN, ['resume', runId], {
      cwd: WORK_ROOT,
      stdio: 'pipe',
      env: BASE_ENV,
      timeout: 20_000,
    })

    expect((await readState(runId)).state).toBe('done')
    const lines = (await readFile(OUTPUT, 'utf-8')).trimEnd().split('\n')
    const items = lines.map((line) => fromPersisted<number>(JSON.parse(line)).item)
    expect(items).toEqual([1, 2, 3, 4, 5])

    // The logger process is gone after the pause, so resumed/done come from the run log.
    const events = await readFile(join(RUNS_DIR, runId, 'events.jsonl'), 'utf-8')
    expect(events).toContain('"type":"started"')
    expect(events).toContain('"type":"paused"')
    expect(events).toContain('"type":"resumed"')
    expect(events).toContain('"type":"done"')
  }, 30_000)
})
