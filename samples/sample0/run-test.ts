import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SAMPLE_DIR = process.cwd()
const CORE_TARBALL = join(SAMPLE_DIR, 'vendor', 'mt-core-0.1.0.tgz')
const CLI_TARBALL = join(SAMPLE_DIR, 'vendor', 'mt-cli-0.1.0.tgz')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

let exitCode = 0
let tempDir: string | null = null

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
  console.log('[1/5] Packing @mt/core tarball...')
  const coreDir = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
  const dest = resolve(SAMPLE_DIR, 'vendor')
  await mkdir(dest, { recursive: true })
  const { code, stderr } = await exec('pnpm', ['-C', coreDir, 'pack', '--pack-destination', dest], {
    forward: true,
  })
  if (code !== 0) {
    throw new Error(`pnpm pack failed: ${stderr}`)
  }
  console.log('   Tarball ready:', CORE_TARBALL)
}

async function packCli(): Promise<void> {
  console.log('[2/5] Packing @mt/cli tarball...')
  const cliDir = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
  const dest = resolve(SAMPLE_DIR, 'vendor')
  await mkdir(dest, { recursive: true })
  const { code, stderr } = await exec('pnpm', ['-C', cliDir, 'pack', '--pack-destination', dest], {
    forward: true,
  })
  if (code !== 0) {
    throw new Error(`pnpm pack failed: ${stderr}`)
  }
  console.log('   Tarball ready:', CLI_TARBALL)
}

async function installDeps(): Promise<void> {
  console.log('[3/5] Installing local @mt/core and @mt/cli (no remote npm)...')
  try {
    await rm(join(SAMPLE_DIR, 'package-lock.json'), { force: true })
  } catch {
    // ignore
  }
  await exec('npm', ['install', '--no-audit', '--no-fund'], { forward: true })
  console.log('   Install complete.')
}

async function runInit(): Promise<void> {
  console.log('[4/5] Running mt init sample-project in a temp directory...')
  tempDir = await mkdtemp(join(tmpdir(), 'mt-init-test-'))
  console.log('   Temp dir:', tempDir)

  const { code, stderr } = await exec(
    MT_BIN,
    ['init', 'sample-project'],
    { cwd: tempDir, forward: true },
  )
  if (code !== 0) {
    throw new Error(`mt init failed: ${stderr}`)
  }
  console.log('   mt init completed.')
}

async function verifyOutput(): Promise<void> {
  if (!tempDir) {
    throw new Error('Temp directory not created')
  }

  console.log('   Verifying scaffolded files...')

  // Verify mt.json
  const configPath = join(tempDir, 'mt.json')
  let configContent: string
  try {
    configContent = await readFile(configPath, 'utf-8')
  } catch (err) {
    throw new Error(`mt.json not found: ${(err as Error).message}`)
  }
  const config = JSON.parse(configContent)
  if (config.project?.name !== 'sample-project') {
    throw new Error(`Expected project.name to be "sample-project", got "${config.project?.name}"`)
  }
  console.log('   mt.json: OK')

  // Verify .mt/ directory
  const mtDir = join(tempDir, '.mt')
  try {
    await access(mtDir)
  } catch {
    throw new Error('.mt/ directory not found')
  }
  for (const sub of ['runs', 'cache']) {
    try {
      await access(join(mtDir, sub))
    } catch {
      throw new Error(`.mt/${sub}/ directory not found`)
    }
  }
  console.log('   .mt/ with runs/ and cache/: OK')

  // Verify pipelines/example.ts
  const pipelinePath = join(tempDir, 'pipelines', 'example.ts')
  let pipelineContent: string
  try {
    pipelineContent = await readFile(pipelinePath, 'utf-8')
  } catch (err) {
    throw new Error(`pipelines/example.ts not found: ${(err as Error).message}`)
  }
  if (!pipelineContent.includes("definePipeline")) {
    throw new Error('pipelines/example.ts does not contain definePipeline')
  }
  if (!pipelineContent.includes("id: 'example'")) {
    throw new Error("pipelines/example.ts does not contain id: 'example'")
  }
  console.log('   pipelines/example.ts: OK')
}

async function cleanup(): Promise<void> {
  console.log('[5/5] Cleaning up generated artifacts...')

  if (tempDir) {
    try {
      await rm(tempDir, { recursive: true, force: true })
      console.log(`   Removed temp dir: ${tempDir}`)
    } catch {
      // ignore
    }
    tempDir = null
  }

  const toRemove = [
    'node_modules',
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
    await runInit()
    await verifyOutput()
    console.log('\nAll verifications passed.')
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
