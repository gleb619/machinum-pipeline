import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { annotate, useCase } from './annotation.js'
import { loadGlobalContext } from './config.js'
import { toExchange, toPersisted } from './exchange.js'
import { formatLogLine } from './logging.js'
import type { GlobalContext, RunContext, ToolContext } from './types/contexts.js'
import type { Exchange, ExchangeInput } from './types/exchange.js'
import type { Logger } from './types/logging.js'
import type { Tool } from './types/pipeline.js'

/** Options of {@link runToolCli}; every output seam is injectable for tests. */
export interface ToolCliOptions {
  /** Raw stdin text. Default: read fd 0 (fails with a usage message on a TTY). */
  input?: string
  /** Project root for `loadGlobalContext` (mt.json, env, vault). Default `process.cwd()`. */
  projectRoot?: string
  /** One stdout line (the result envelope). Default `process.stdout`. */
  stdout?: (line: string) => void
  /** One stderr line (diagnostics). Default `process.stderr`. */
  stderr?: (line: string) => void
}

/**
 * Standalone CLI adapter for a {@link Tool} (UC011): read one JSON exchange on stdin,
 * invoke the tool with a minimal `ToolContext`, write the persisted result envelope as
 * one JSON line on stdout. Bin scripts publish it as an npm `bin`:
 *
 * ```ts
 * #!/usr/bin/env node
 * import { runToolCli } from '@mt/core'
 * import { myTool } from './tool.js'
 * process.exitCode = await runToolCli(myTool)
 * ```
 *
 * The stdin contract is the one `mt tool` accepts (`{ id?, item, items?, meta?, variables? }`,
 * normalized by `toExchange`). Diagnostics and log lines go to stderr so stdout stays
 * machine-readable; `meta` is dropped from the output per the persistence contract.
 *
 * @returns Process exit code: `0` on success, `1` on a bad stdin payload or a failed invoke.
 */
export async function runToolCli<I, O>(
  tool: Tool<I, O>,
  options: ToolCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))

  const input = readInput(options, stderr)
  if (typeof input !== 'string') return input

  let envelope: Exchange<I>
  try {
    envelope = toExchange(JSON.parse(input) as ExchangeInput<I>)
  } catch (error) {
    stderr(`Error: invalid JSON on stdin: ${messageOf(error)}`)
    return 1
  }

  const projectRoot = options.projectRoot ?? process.cwd()
  let globalContext: GlobalContext
  try {
    globalContext = await loadGlobalContext(projectRoot)
  } catch (error) {
    stderr(`Error: cannot load project context from ${projectRoot}: ${messageOf(error)}`)
    return 1
  }

  const runId = `tool-${randomUUID()}`
  // stderr keeps stdout reserved for the machine-readable result document
  const logger: Logger = {
    info: (message: string, meta?: Record<string, unknown>) =>
      stderr(formatLogLine('info', message, meta)),
    warn: (message: string, meta?: Record<string, unknown>) =>
      stderr(formatLogLine('warn', message, meta)),
    error: (message: string, meta?: Record<string, unknown>) =>
      stderr(formatLogLine('error', message, meta)),
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (process.env.MT_DEBUG) stderr(formatLogLine('debug', message, meta))
    },
  }
  const runContext: RunContext = {
    runId,
    pipelineId: tool.name,
    startedAt: new Date().toISOString(),
    global: globalContext,
    checkpoint: { stepId: 'standalone', depth: 0, path: ['standalone'] },
    logger,
    artifactsDir: join(projectRoot, '.mt', 'runs', runId, 'artifacts'),
  }
  const toolContext: ToolContext = {
    run: runContext,
    step: { stepId: `standalone/${tool.name}`, name: tool.name, type: 'tool', index: 0 },
  }

  try {
    const output = await tool.invoke(envelope, toolContext)
    stdout(JSON.stringify(toPersisted(output)))
  } catch (error) {
    stderr(`Error: tool '${tool.name}' failed: ${messageOf(error)}`)
    return 1
  }
  return 0
}

/** Stdin text, or the exit code of the usage/empty-stdin error already reported. */
function readInput(options: ToolCliOptions, stderr: (line: string) => void): string | number {
  if (options.input === undefined) {
    if (process.stdin.isTTY) {
      stderr('Usage: <tool> < exchange.json')
      stderr('Pipe a JSON exchange (id/variables optional) on stdin, e.g.:')
      stderr('  echo \'{"item":"x","meta":{}}\' | <tool>')
      return 1
    }
    return trimInput(readFileSync(0, 'utf8'), stderr)
  }
  return trimInput(options.input, stderr)
}

function trimInput(input: string, stderr: (line: string) => void): string | number {
  const trimmed = input.trim()
  if (trimmed === '') {
    stderr('Error: empty stdin — expected a JSON exchange like {"item":"x","meta":{}}')
    return 1
  }
  return trimmed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

annotate(
  runToolCli,
  useCase('UC011', {
    name: 'Invoke a Tool via npx',
    description: 'Expose a Tool as a standalone stdin/stdout JSON CLI from an npm bin script.',
  }),
)
