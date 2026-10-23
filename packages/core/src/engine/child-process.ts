import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '../contexts.js'
import type { Envelope } from '../types.js'

/**
 * Runtime able to execute a tool out-of-process.
 */
export type ChildRuntime = 'npx' | 'deno' | 'bun'

/**
 * Options for spawning a child process tool.
 */
export interface ChildProcessOptions {
  command: ChildRuntime
  args: string[]
  timeout?: number
}

/**
 * Result from a child process tool execution.
 */
export interface ChildProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Leading argv per runtime — everything after that is the worker entry. */
const RUNTIME_ARGV: Record<ChildRuntime, readonly string[]> = {
  bun: ['run'],
  deno: ['run', '-A'],
  npx: ['tsx'],
}

/**
 * Absolute path to the `mt-worker` entry script.
 *
 * Resolves next to this module: `dist/engine/worker.js` when running from the
 * built package, `src/engine/worker.ts` when running from source (tests, tsx).
 */
export function workerPath(): string {
  for (const candidate of ['./worker.js', './worker.ts']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) {
      return path
    }
  }
  throw new Error(`Cannot locate mt-worker entry (worker.js/worker.ts) next to ${import.meta.url}`)
}

/**
 * Build the child argv for a tool: `<runtime> <runtime argv> <worker> <module> <toolName>`.
 *
 * The worker is always the entry script; the tool module is imported *by* the
 * worker, so the runtime only needs to know how to execute the worker.
 */
export function resolveToolCommand(
  exec: ChildRuntime,
  module: string | undefined,
  toolName: string,
): ChildProcessOptions {
  const argv = RUNTIME_ARGV[exec]
  if (!argv) {
    throw new Error(`Unknown exec runtime '${exec}' — expected one of: bun, deno, npx`)
  }
  if (!module) {
    throw new Error(
      `Tool '${toolName}' declares exec: '${exec}' but no \`module\`. Set \`module\` in defineTool() to the file path of the module exporting the tool.`,
    )
  }
  return { command: exec, args: [...argv, workerPath(), module, toolName] }
}

/** First line written to a child's stdin — carries the tool context. */
function initLine(toolContext: ToolContext): string {
  return `${JSON.stringify({ type: 'init', toolContext })}\n`
}

/** Extract the message from a worker error line (`{"error":"..."}`), if present. */
function errorFromOutput(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const { error } = parsed as { error: unknown }
        if (typeof error === 'string') return error
      }
    } catch {
      // Non-JSON line (tool debug output) — ignore.
    }
  }
  return undefined
}

/** Build the Error thrown when a child exits non-zero, carrying its stderr. */
function childFailure(options: ChildProcessOptions, result: ChildProcessResult): Error {
  const command = [options.command, ...options.args].join(' ')
  const reported = errorFromOutput(result.stdout) ?? result.stderr.trim()
  const detail = reported || `no output (exit code ${result.exitCode})`
  const stderr = result.stderr.trim()
  return new Error(
    `Child process failed: ${command}\n${detail}${stderr && stderr !== reported ? `\n${stderr}` : ''}`,
  )
}

/**
 * Execute a tool in a child process.
 *
 * Uses the single NDJSON protocol shared with {@link streamChildProcess}: the
 * tool context goes out as the first stdin line, one envelope per line after
 * that; the worker answers with one envelope (or `{error}`) per line on stdout.
 */
export async function runChildProcess<O>(
  options: ChildProcessOptions,
  envelope: Envelope<unknown>,
  toolContext: ToolContext,
): Promise<Envelope<O>> {
  const result = await spawnChildProcess(options, envelope, toolContext)
  if (result.exitCode !== 0) {
    throw childFailure(options, result)
  }
  const failure = errorFromOutput(result.stdout)
  if (failure) {
    throw new Error(`Tool in child process failed: ${failure}`)
  }
  // Lenient: only one envelope is expected, so stray debug output is skipped.
  for (const line of result.stdout.split('\n')) {
    const parsed = parseLine<O>(line)
    if (parsed) return parsed
  }
  throw new Error(`Tool in child process produced no output: ${result.stderr.trim() || '(empty)'}`)
}

/**
 * Stream envelopes through a child process for batch processing.
 *
 * Same NDJSON protocol as {@link runChildProcess}: one init line, then one
 * envelope per line; the worker writes one envelope (or `{error}`) per line.
 */
export async function* streamChildProcess<I, O>(
  options: ChildProcessOptions,
  envelopes: AsyncIterable<Envelope<I>>,
  toolContext: ToolContext,
): AsyncIterable<Envelope<O>> {
  const child = spawn(options.command, options.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Collect stderr in the background — read on 'close', so a slow reader never
  // blocks the child and vice versa.
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  // Write the init line, then one envelope per line. Errors here mean the child
  // is already gone — surface them via the exit code instead of hanging.
  const writePromise = (async () => {
    try {
      child.stdin.write(initLine(toolContext))
      for await (const env of envelopes) {
        const line = `${JSON.stringify(env)}\n`
        if (!child.stdin.write(line, 'utf8')) {
          await new Promise<void>((resolve) => child.stdin.once('drain', resolve))
        }
      }
    } catch {
      // stdin closed early; the exit-code check below reports the real failure.
    } finally {
      child.stdin.end()
    }
  })()

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseLine<O>(line, true)
      if (parsed) yield parsed
    }
  }

  if (buffer.trim()) {
    const parsed = parseLine<O>(buffer, true)
    if (parsed) yield parsed
  }

  await writePromise

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', resolve)
  })

  if (exitCode !== 0) {
    throw childFailure(options, { stdout: '', stderr, exitCode })
  }
}

/**
 * Parse one NDJSON line.
 *
 * Blank lines and non-JSON lines (a tool writing debug output to stdout) are
 * skipped; a `{error}` line throws. In `strict` mode (streaming, where every
 * line must map to an envelope) an unparseable line throws instead of being
 * skipped — silently dropping it would lose data.
 */
function parseLine<O>(line: string, strict = false): Envelope<O> | undefined {
  if (!line.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    if (strict) throw new Error(`Child process wrote a non-NDJSON line: ${line}`)
    return undefined
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const { error } = parsed as { error: unknown }
    throw new Error(`Tool in child process failed: ${String(error)}`)
  }
  return parsed as Envelope<O>
}

/**
 * Spawn a child process and run a single envelope through the NDJSON protocol.
 */
async function spawnChildProcess(
  options: ChildProcessOptions,
  envelope: Envelope<unknown>,
  toolContext: ToolContext,
): Promise<ChildProcessResult> {
  return new Promise<ChildProcessResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 })
    })

    child.on('error', reject)

    child.stdin.write(initLine(toolContext))
    child.stdin.write(`${JSON.stringify(envelope)}\n`)
    child.stdin.end()
  })
}
