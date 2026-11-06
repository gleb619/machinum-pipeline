import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
}

export function run(file: string, options: RunOptions = {}): string {
  return execFileSync(MT_BIN, ['run', `./pipelines/${file}`], {
    cwd: SAMPLE_DIR,
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

export async function clean(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
}

export function lintParity(enDir: string, ruDir: string) {
  return spawnSync(TSX_BIN, ['lint-parity.ts', enDir, ruDir], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
  })
}
