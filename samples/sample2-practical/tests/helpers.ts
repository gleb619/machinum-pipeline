import { execFileSync, spawnSync } from 'node:child_process'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const SAMPLE_DIR = resolve(import.meta.dirname, '..')
export const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
export const TSX_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'tsx')
export const CHAPTERS = join(SAMPLE_DIR, 'chapters')

export const BASE_ENV = {
  ...process.env,
  NODE_OPTIONS: '--import tsx',
  MT_LLM_TOOL: 'mock',
}

export interface RunOptions {
  env?: Record<string, string>
  timeout?: number
  /** Project root to run in (default: the sample itself). */
  cwd?: string
}

export function run(file: string, options: RunOptions = {}): string {
  return execFileSync(MT_BIN, ['run', join(SAMPLE_DIR, 'pipelines', file)], {
    cwd: options.cwd ?? SAMPLE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...BASE_ENV, ...options.env },
    timeout: options.timeout ?? 60_000,
  })
}

export async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

/**
 * Empties a directory while keeping its tracked `.gitkeep`, so a test run never deletes a
 * repository file. A directory without a `.gitkeep` (an output directory) is removed entirely.
 */
async function cleanPath(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => undefined)
  if (!stats?.isDirectory()) {
    await rm(path, { recursive: true, force: true })
    return
  }
  let keepsGitkeep = false
  for (const name of await readdir(path)) {
    if (name === '.gitkeep') {
      keepsGitkeep = true
      continue
    }
    await rm(join(path, name), { recursive: true, force: true })
  }
  if (!keepsGitkeep) await rm(path, { recursive: true, force: true })
}

export async function clean(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => cleanPath(path)))
}

export function lintParity(enDir: string, ruDir: string) {
  return spawnSync(TSX_BIN, ['lint-parity.ts', enDir, ruDir], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
  })
}
