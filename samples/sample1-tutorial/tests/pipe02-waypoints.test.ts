import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BASE_ENV, CHAPTERS, MT_BIN, SAMPLE_DIR, TSX_BIN, clean } from './helpers.js'

const HEALTH_URL = 'http://127.0.0.1:9877/health'
const JSONL = join(SAMPLE_DIR, 'jsonl', 'http-output.jsonl')
const TITLES = [
  'Chapter 1: The Road from Thornhaven',
  'Chapter 2: Ambush in the Darkwood',
  'Chapter 3: The Duke’s Tribunal',
]

let child: ReturnType<typeof spawn> | null = null
let hasFailure = false

async function waitForHealth(maxRetries = 100, pollMs = 100): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) })
      const body = (await response.json()) as { status?: string }
      if (body.status === 'ok') return
    } catch {
      // not ready yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
  throw new Error('HTTP source did not become healthy in time')
}

function waitForExit(proc: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      rejectExit(new Error('pipe02 suite did not finish in time'))
    }, 15_000)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
    proc.once('error', (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
  })
}

beforeAll(async () => {
  await clean(JSONL, join(CHAPTERS, 'en'), join(CHAPTERS, 'ru'), join(SAMPLE_DIR, '.mt'))
  await mkdir(join(CHAPTERS, 'en'), { recursive: true })
  await mkdir(join(CHAPTERS, 'ru'), { recursive: true })
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  if (!hasFailure) await clean(JSONL, join(SAMPLE_DIR, '.mt'))
})

describe('pipe02 waypoints (HTTP source, aliases, custom scheme)', () => {
  it('ingests three posted chapters, writes JSONL, then both language folders', async () => {
    child = spawn(MT_BIN, ['run', './pipelines/pipe02-waypoints.ts'], {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: BASE_ENV,
    })
    let childLog = ''
    child.stdout?.on('data', (chunk) => {
      childLog += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      childLog += String(chunk)
    })

    await waitForHealth().catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${childLog}`)
    })
    execFileSync(TSX_BIN, ['simulate-book1.ts'], {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: BASE_ENV,
      timeout: 15_000,
    })
    const code = await waitForExit(child)
    child = null
    expect(code).toBe(0)

    const lines = (await readFile(JSONL, 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    for (const title of TITLES) expect(await readFile(JSONL, 'utf-8')).toContain(title)

    expect((await readdir(join(CHAPTERS, 'en'))).filter((f) => f.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
      'chapter3.md',
    ])
    expect((await readdir(join(CHAPTERS, 'ru'))).filter((f) => f.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
      'chapter3.md',
    ])

    const en = await readFile(join(CHAPTERS, 'en', 'chapter2.md'), 'utf-8')
    expect(en).toContain(TITLES[1] as string)
    const ru = await readFile(join(CHAPTERS, 'ru', 'chapter2.md'), 'utf-8')
    expect(ru).toContain('[ru]')
    expect(ru).toContain('[/ru]')
  })
})
