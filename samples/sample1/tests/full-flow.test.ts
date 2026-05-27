import { execSync, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const HEALTH_URL = 'http://127.0.0.1:9876/health'
const ORIGINAL_PIPELINE = join(SAMPLE_DIR, 'pipelines', 'http-to-jsonl.ts')
const TEST_PIPELINE = join(SAMPLE_DIR, 'pipelines', 'http-to-jsonl-test.ts')

let runnerProc: ReturnType<typeof spawn> | null = null
let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'output.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
  await rm(TEST_PIPELINE, { force: true })
}

async function waitForHealth(maxRetries = 30, pollMs = 100): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) })
      const body = (await res.json()) as { status?: string }
      if (body.status === 'ok') return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error('HTTP source did not become healthy in time')
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true })

  let pipelineSrc = await readFile(ORIGINAL_PIPELINE, 'utf-8')
  pipelineSrc = pipelineSrc.replace('hs://localhost:9876/', 'hs://localhost:9876/?count=3')
  await writeFile(TEST_PIPELINE, pipelineSrc, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (runnerProc && !runnerProc.killed) {
    runnerProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    if (!runnerProc.killed) runnerProc.kill('SIGKILL')
  }

  if (!hasFailure) {
    await cleanup()
  }
})

describe('full-flow pipeline', () => {
  it('runs http-to-jsonl then jsonl-to-md end to end', async () => {
    runnerProc = spawn(MT_BIN, ['run', './pipelines/http-to-jsonl-test.ts'], {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    })
    runnerProc.stdout?.on('data', () => {})
    runnerProc.stderr?.on('data', () => {})

    await waitForHealth()

    execSync('npm run simulate', {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, MT_HTTP_URL: 'http://localhost:9876' },
      timeout: 10_000,
    })

    // Wait for async target I/O to flush and runner to finish
    await new Promise((r) => setTimeout(r, 1000))

    // Run jsonl-to-md (reads all *.jsonl in the jsonl folder)
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md.ts`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })

    // Assertions
    const titles = [
      'Chapter 1: The Road from Thornhaven',
      'Chapter 2: Ambush in the Darkwood',
      'Chapter 3: The Duke\u2019s Tribunal',
    ]
    for (let i = 0; i < titles.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain(titles[i])
    }
  })
})
