import { execSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const CORE_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
const CLI_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
const WAYPOINT_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'waypoint')
const TOOLS_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'tools')
const BOOKS_DIR = resolve(SAMPLE_DIR, '..', '..', 'books', 'book1')
const HEALTH_URL = 'http://127.0.0.1:9876/health'

let baseTmpDir: string
let workDir: string
let runnerProc: ReturnType<typeof spawn> | null = null
let hasFailure = false

async function waitForHealth(maxRetries = 50, pollMs = 200): Promise<void> {
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
  baseTmpDir = await mkdtemp(join(tmpdir(), 'mt-sample1-full-flow-'))
  workDir = join(baseTmpDir, 'samples', 'sample1')
  const vendorDir = join(workDir, 'vendor')
  await mkdir(vendorDir, { recursive: true })
  await mkdir(join(workDir, 'jsonl'), { recursive: true })
  await mkdir(join(workDir, 'chapters', 'en'), { recursive: true })

  execSync(`pnpm -C "${CORE_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${CLI_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${WAYPOINT_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${TOOLS_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })

  const pkgJson = {
    name: 'sample1-full-flow-test',
    type: 'module',
    dependencies: {
      '@mt/core': 'file:./vendor/mt-core-0.1.0.tgz',
      '@mt/cli': 'file:./vendor/mt-cli-0.1.0.tgz',
      '@mt/waypoint': 'file:./vendor/mt-waypoint-0.1.0.tgz',
      '@mt/tools': 'file:./vendor/mt-tools-0.1.0.tgz',
      tsx: '^4.19.0',
    },
  }
  await writeFile(join(workDir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  execSync('npm install --no-audit --no-fund', { cwd: workDir, stdio: 'pipe', timeout: 120_000 })

  await cp(join(SAMPLE_DIR, 'mt.json'), join(workDir, 'mt.json'))
  await cp(join(SAMPLE_DIR, 'pipelines'), join(workDir, 'pipelines'), { recursive: true })
  await cp(join(SAMPLE_DIR, 'simulation1.ts'), join(workDir, 'simulation1.ts'))

  // Patch pipeline to limit HTTP source to 3 envelopes so the runner exits
  const pipelinePath = join(workDir, 'pipelines', 'http-to-jsonl.ts')
  let pipelineSrc = await readFile(pipelinePath, 'utf-8')
  pipelineSrc = pipelineSrc.replace('hs://localhost:9876/', 'hs://localhost:9876/?count=3')
  await writeFile(pipelinePath, pipelineSrc, 'utf-8')

  // simulation1.ts resolves books via ../../books/book1 relative to its own location
  const simBooksDir = resolve(workDir, '..', '..', 'books', 'book1')
  await mkdir(join(simBooksDir, '..'), { recursive: true })
  await cp(BOOKS_DIR, simBooksDir, { recursive: true })
}, 240_000)

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

  if (hasFailure) {
    console.log(`Skipping cleanup because a test failed. Work directory: ${workDir}`)
    return
  }

  if (baseTmpDir) {
    await rm(baseTmpDir, { recursive: true, force: true })
  }
})

describe('full-flow pipeline', () => {
  it('runs http-to-jsonl then jsonl-to-md end to end', async () => {
    const mtBin = join(workDir, 'node_modules', '.bin', 'mt')
    runnerProc = spawn('node', ['--import', 'tsx', mtBin, 'run', './pipelines/http-to-jsonl.ts'], {
      cwd: workDir,
      stdio: 'pipe',
      env: { ...process.env },
    })
    runnerProc.stdout?.on('data', () => {})
    runnerProc.stderr?.on('data', () => {})

    await waitForHealth()

    execSync('npx tsx simulation1.ts', {
      cwd: workDir,
      stdio: 'pipe',
      env: { ...process.env, MT_HTTP_URL: 'http://localhost:9876' },
      timeout: 30_000,
    })

    // Wait for async target I/O to flush and runner to finish
    await new Promise((r) => setTimeout(r, 2000))

    // Run jsonl-to-md (reads all *.jsonl in the jsonl folder)
    execSync(`node --import tsx "${mtBin}" run ./pipelines/jsonl-to-md.ts`, {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 30_000,
    })

    // Assertions
    const titles = [
      'Chapter 1: The Road from Thornhaven',
      'Chapter 2: Ambush in the Darkwood',
      'Chapter 3: The Duke\u2019s Tribunal',
    ]
    for (let i = 0; i < titles.length; i++) {
      const content = await readFile(join(workDir, 'chapters', 'en', `chapter${i + 1}.md`), 'utf-8')
      expect(content).toContain(titles[i])
    }
  })
})
