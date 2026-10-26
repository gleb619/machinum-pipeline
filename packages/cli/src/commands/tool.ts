import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadGlobalContext } from '@mt/core'
import type { Envelope, Logger, RunContext, ToolContext } from '@mt/core'
import { findTool, listToolNames } from '../utils/find-tool.js'
import type { ToolMatch } from '../utils/find-tool.js'

/**
 * `mt tool <name> [--pipeline <file>]` — invoke a tool standalone.
 *
 * Reads a JSON envelope from stdin, invokes the tool, writes the JSON result to stdout.
 * The tool is found by scanning the tool steps of the pipelines declared in mt.json
 * (see utils/find-tool.ts); `--pipeline` restricts the search to a single pipeline file.
 */
export async function toolCommand(args: string[]): Promise<void> {
  const toolName = args[0]
  if (!toolName) usage()

  let pipelineFile: string | undefined
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--pipeline') {
      const value = args[i + 1]
      if (!value) {
        console.error('Error: --pipeline requires a file argument')
        process.exit(1)
      }
      pipelineFile = value
      break
    }
    console.error(`Error: Unknown option for mt tool: ${arg}`)
    usage()
  }

  const projectRoot = process.cwd()

  // Resolve the tool before touching stdin, so a bad name never hangs waiting for input.
  let match: ToolMatch | undefined
  try {
    match = await findTool(projectRoot, toolName, pipelineFile)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (!match) {
    const available = await listToolNames(projectRoot, pipelineFile)
    console.error(`Unknown tool: ${toolName}`)
    console.error(
      available.length > 0
        ? `Available tools: ${available.join(', ')}`
        : 'No tools found in the declared pipelines (see mt.json pipelines[]).',
    )
    process.exit(1)
  }

  if (process.stdin.isTTY) {
    console.error('Usage: mt tool <name> [--pipeline <file>]')
    console.error(
      `Pipe a JSON envelope on stdin, e.g.: echo '{"item":"x","meta":{}}' | mt tool ${toolName}`,
    )
    process.exit(1)
  }

  const input = readFileSync(0, 'utf8').trim()
  if (input === '') {
    console.error('Error: empty stdin — expected a JSON envelope like {"item":"x","meta":{}}')
    process.exit(1)
  }

  let envelope: Envelope<unknown>
  try {
    envelope = JSON.parse(input) as Envelope<unknown>
  } catch (error) {
    console.error(
      `Error: invalid JSON on stdin: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }

  const globalContext = await loadGlobalContext(projectRoot)
  const runId = `tool-${randomUUID()}`
  const logger: Logger = {
    info: (message) => console.error(`[info] ${message}`),
    warn: (message) => console.error(`[warn] ${message}`),
    error: (message) => console.error(`[error] ${message}`),
    debug: () => {},
  }
  const runContext: RunContext = {
    runId,
    pipelineId: match.pipelineId,
    startedAt: new Date().toISOString(),
    global: globalContext,
    checkpoint: { stepId: 'standalone', depth: 0, path: ['standalone'] },
    logger,
    artifactsDir: join(projectRoot, '.mt', 'runs', runId, 'artifacts'),
  }
  const toolContext: ToolContext = {
    run: runContext,
    step: {
      stepId: `standalone/${match.tool.name}`,
      name: match.tool.name,
      type: 'tool',
      index: 0,
    },
  }

  try {
    const output = await match.tool.invoke(envelope, toolContext)
    console.log(JSON.stringify(output))
  } catch (error) {
    console.error(
      `Error: tool '${match.tool.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

function usage(): never {
  console.error('Usage: mt tool <name> [--pipeline <file>]')
  console.error('  Invoke a tool standalone (JSON envelope on stdin, JSON result on stdout)')
  process.exit(1)
}
