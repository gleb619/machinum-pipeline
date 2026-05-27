import { execSync, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAMPLE_DIR = import.meta.dirname
const HEALTH_URL = 'http://127.0.0.1:9876/health'

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

let runnerProc: ReturnType<typeof spawn> | null = null
let examplePipelinePath: string | null = null

async function main(): Promise<void> {
  // Patch pipeline for example
  const originalPipelinePath = join(SAMPLE_DIR, 'pipelines', 'http-to-jsonl.ts')
  examplePipelinePath = join(SAMPLE_DIR, 'pipelines', 'http-to-jsonl-example.ts')
  let pipelineSrc = await readFile(originalPipelinePath, 'utf-8')
  pipelineSrc = pipelineSrc.replace('hs://localhost:9876/', 'hs://localhost:9876/?count=3')
  await writeFile(examplePipelinePath, pipelineSrc, 'utf-8')

  // Ensure jsonl dir exists
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })

  // Start runner
  runnerProc = spawn('npm', ['run', 'runner:http'], {
    cwd: SAMPLE_DIR,
    stdio: 'inherit',
    env: { ...process.env },
  })

  // Wait for health
  await waitForHealth()

  // Run simulation
  execSync('npm run simulate', {
    cwd: SAMPLE_DIR,
    stdio: 'inherit',
    env: { ...process.env, MT_HTTP_URL: 'http://localhost:9876' },
    timeout: 30_000,
  })

  // Wait for runner to exit
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (runnerProc && !runnerProc.killed) {
        runnerProc.kill('SIGTERM')
      }
      const killTimer = setTimeout(() => {
        if (runnerProc && !runnerProc.killed) {
          runnerProc.kill('SIGKILL')
        }
      }, 2000)
      runnerProc?.on('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
    }, 10_000)

    runnerProc?.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(`Runner exited with code ${code}`))
      }
    })

    runnerProc?.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  // Run md pipeline (reads all *.jsonl in the jsonl folder)
  execSync('npm run runner:md', {
    cwd: SAMPLE_DIR,
    stdio: 'inherit',
    timeout: 30_000,
  })
}

main()
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
  .finally(async () => {
    if (examplePipelinePath) {
      await rm(examplePipelinePath, { force: true })
    }
  })
