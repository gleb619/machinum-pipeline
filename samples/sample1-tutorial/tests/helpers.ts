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
  pipeline?: string
  env?: Record<string, string>
  timeout?: number
}

/** Run one pipeline file (optionally a named export) and return its stdout. */
export function run(file: string, options: RunOptions = {}): string {
  const args = ['run', `./pipelines/${file}`]
  if (options.pipeline) args.push('--pipeline', options.pipeline)
  return execFileSync(MT_BIN, args, {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...BASE_ENV, ...options.env },
    timeout: options.timeout ?? 30_000,
  })
}

export function runScript(script: string, args: string[] = []): string {
  return execFileSync(TSX_BIN, [script, ...args], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: BASE_ENV,
    timeout: 30_000,
  })
}

/** Write a JSONL file of `{ item }` envelopes. */
export async function writeJsonl(path: string, items: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${items.map((item) => JSON.stringify({ item })).join('\n')}\n`, 'utf-8')
}

/** Remove generated files/directories; missing paths are ignored. */
export async function clean(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
}

/** The JSON object of every structured log line (`... <message> {json}`). */
export function logs(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const start = line.indexOf('{')
    if (start === -1) continue
    try {
      out.push(JSON.parse(line.slice(start)) as Record<string, unknown>)
    } catch {
      // Not a JSON log line.
    }
  }
  return out
}

/** `pnpm run lint:parity` as a child process (exit code + output). */
export function lintParity(enDir: string, ruDir: string) {
  return spawnSync(TSX_BIN, ['lint-parity.ts', enDir, ruDir], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
  })
}
