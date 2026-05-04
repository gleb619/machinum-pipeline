import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const SAMPLE_DIR = process.cwd()
const CORE_TARBALL = join(SAMPLE_DIR, 'vendor', 'mt-core-0.1.0.tgz')
const CLI_TARBALL = join(SAMPLE_DIR, 'vendor', 'mt-cli-0.1.0.tgz')
const HEALTH_URL = 'http://127.0.0.1:9876/health'
const HEALTH_POLL_MS = 200
const HEALTH_MAX_RETRIES = 50

let runnerProc: ChildProcess | null = null
let exitCode = 0

/* ------------------------------------------------------------------ */
// Helpers
/* ------------------------------------------------------------------ */

interface ExecOptions {
  cwd?: string
  forward?: boolean
  env?: Record<string, string>
  allowError?: boolean
}

async function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd ?? SAMPLE_DIR
    const env = { ...process.env, ...(options.env ?? {}) }
    const proc = spawn(command, args, {
      cwd,
      stdio: options.forward ? 'inherit' : 'pipe',
      env,
    })

    let stdout = ''
    let stderr = ''

    if (!options.forward) {
      proc.stdout?.on('data', (d) => {
        stdout += d
        process.stdout.write(`[${command}] ${d}`)
      })
      proc.stderr?.on('data', (d) => {
        stderr += d
        process.stderr.write(`[${command}] ${d}`)
      })
    }

    proc.on('close', (code) => {
      if (code !== 0 && !options.allowError) {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code}. stderr: ${stderr}`))
      } else {
        resolve({ code: code ?? 0, stdout, stderr })
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

async function packCore(): Promise<void> {
  console.log('[1/8] Packing @mt/core tarball...')
  const coreDir = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
  const dest = resolve(SAMPLE_DIR, 'vendor')
  const { code, stderr } = await exec('pnpm', ['-C', coreDir, 'pack', '--pack-destination', dest], {
    forward: true,
  })
  if (code !== 0) {
    throw new Error(`pnpm pack failed: ${stderr}`)
  }
  console.log('   Tarball ready:', CORE_TARBALL)
}

async function packCli(): Promise<void> {
  console.log('[2/8] Packing @mt/cli tarball...')
  const cliDir = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
  const dest = resolve(SAMPLE_DIR, 'vendor')
  const { code, stderr } = await exec('pnpm', ['-C', cliDir, 'pack', '--pack-destination', dest], {
    forward: true,
  })
  if (code !== 0) {
    throw new Error(`pnpm pack failed: ${stderr}`)
  }
  console.log('   Tarball ready:', CLI_TARBALL)
}

async function installDeps(): Promise<void> {
  console.log('[3/8] Installing local @mt/core and @mt/cli (no remote npm)...')
  try {
    await rm(join(SAMPLE_DIR, 'package-lock.json'), { force: true })
  } catch {
    // ignore
  }
  await exec('npm', ['install', '--no-audit', '--no-fund'], { forward: true })
  console.log('   Install complete.')
}

async function waitForHealth(): Promise<void> {
  console.log('[5/8] Waiting for HTTP source /health...')
  for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        const body = await res.json() as { status?: string }
        if (body.status === 'ok') {
          console.log('   HTTP source is ready.')
          return
        }
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error('HTTP source did not become healthy in time')
}

async function runSimulation(): Promise<void> {
  console.log('[6/8] Running simulation1.ts (reading en.md files from books/book1)...')
  const { code } = await exec(
    'npx',
    ['tsx', 'simulation1.ts'],
    { forward: true, env: { MT_HTTP_URL: 'http://localhost:9876' } },
  )
  if (code !== 0) {
    throw new Error('Simulation failed')
  }
  console.log('   Simulation complete.')
}

async function verifyOutput(): Promise<void> {
  console.log('[7/8] Verifying jsonl/output.jsonl...')
  const outputPath = join(SAMPLE_DIR, 'jsonl', 'output.jsonl')
  let content: string
  try {
    content = await readFile(outputPath, 'utf-8')
  } catch (err) {
    throw new Error(`jsonl/output.jsonl not found: ${(err as Error).message}`)
  }

  const lines = content.trim().split('\n').filter(Boolean)
  console.log(`   Found ${lines.length} line(s) in jsonl/output.jsonl`)

  if (lines.length !== 3) {
    throw new Error(`Expected exactly 3 lines, got ${lines.length}`)
  }

  const titles: string[] = []
  for (const line of lines) {
    let envelope: { item?: { title?: string } }
    try {
      envelope = JSON.parse(line) as { item?: { title?: string } }
    } catch {
      throw new Error(`Invalid JSON line: ${line.slice(0, 80)}`)
    }
    if (!envelope.item || typeof envelope.item.title !== 'string') {
      throw new Error(`Missing title in envelope: ${line.slice(0, 80)}`)
    }
    titles.push(envelope.item.title)
  }

  const expectedTitles = [
    'Chapter 1: The Road from Thornhaven',
    'Chapter 2: Ambush in the Darkwood',
    "Chapter 3: The Duke’s Tribunal",
  ]
  for (const expected of expectedTitles) {
    if (!titles.includes(expected)) {
      throw new Error(`Expected title not found in output: "${expected}"`)
    }
  }

  console.log('   All 3 expected chapters found in jsonl/output.jsonl.')
}

async function cleanup(): Promise<void> {
  console.log('[8/8] Cleaning up generated artifacts...')

  if (runnerProc && !runnerProc.killed) {
    runnerProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    if (!runnerProc.killed) {
      runnerProc.kill('SIGKILL')
    }
  }

  const gitDir = join(SAMPLE_DIR, '.git')
  try {
    await access(gitDir)
    await rm(gitDir, { recursive: true, force: true })
    console.log('   Removed .git/')
  } catch {
    // .git did not exist
  }

  const { execFile } = await import('node:child_process')
  try {
    const repoRootResult = await new Promise<string>((resolve, reject) => {
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd: SAMPLE_DIR }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.trim())
      })
    })
    const worktreesDir = join(repoRootResult, 'worktrees')
    try {
      await access(worktreesDir)
      await rm(worktreesDir, { recursive: true, force: true })
      console.log('   Removed worktrees/')
    } catch {
      // ignore
    }
  } catch {
    // not in a git repo
  }

  const toRemove = [
    'node_modules',
    '.mt',
    'jsonl',
    'package-lock.json',
    'npm-debug.log',
    'vendor',
  ]

  for (const name of toRemove) {
    const p = join(SAMPLE_DIR, name)
    try {
      await rm(p, { recursive: true, force: true })
      console.log(`   Removed ${name}/`)
    } catch {
      // ignore
    }
  }

  console.log('   Cleanup complete.')
}

/* ------------------------------------------------------------------ */
// Main
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  try {
    await packCore()
    await packCli()
    await installDeps()

    console.log('[4/8] Starting pipeline (pnpm run runner)...')
    await mkdir(join(SAMPLE_DIR, "jsonl"), { recursive: true })
    runnerProc = spawn('pnpm', ['run', 'runner'], {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_OPTIONS: '--import tsx',
      },
    })
    runnerProc.stdout?.on('data', (d) => process.stdout.write(`[runner] ${d}`))
    runnerProc.stderr?.on('data', (d) => process.stderr.write(`[runner] ${d}`))

    await waitForHealth()
    await runSimulation()

    console.log('[7/8] Waiting for async target I/O...')
    await new Promise((r) => setTimeout(r, 2000))

    await verifyOutput()
  } catch (err) {
    console.error('\nTEST FAILED:', (err as Error).message)
    exitCode = 1
  } finally {
    await cleanup()
  }

  if (exitCode === 0) {
    console.log('\nTEST PASSED')
  } else {
    console.log('\nTEST FAILED')
  }
  process.exit(exitCode)
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
