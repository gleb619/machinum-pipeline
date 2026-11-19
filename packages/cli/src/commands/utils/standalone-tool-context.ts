import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { formatLogLine, loadGlobalContext } from '@mt/core'
import type { Logger, RunContext, ToolContext } from '@mt/core'

/**
 * Minimal RunContext/ToolContext for a standalone tool invocation (`mt tool`,
 * `mt tools call`). Mirrors what the Runner builds, without a Runner: one
 * `tool-<uuid>` run id, checkpoint id `standalone`, no source and no target.
 */

/** Logger writing every line to stderr — stdout stays reserved for the result document. */
export function createStderrLogger(): Logger {
  return {
    info: (message, meta) => console.error(formatLogLine('info', message, meta)),
    warn: (message, meta) => console.error(formatLogLine('warn', message, meta)),
    error: (message, meta) => console.error(formatLogLine('error', message, meta)),
    debug: (message, meta) => {
      if (process.env.MT_DEBUG) console.error(formatLogLine('debug', message, meta))
    },
  }
}

export interface StandaloneToolContext {
  runContext: RunContext
  toolContext: ToolContext
  logger: Logger
}

/**
 * Build the standalone invocation context of one tool: the project's
 * GlobalContext plus a run id, checkpoint handle and artifacts dir.
 */
export async function createStandaloneToolContext(options: {
  projectRoot: string
  toolName: string
  pipelineId: string
}): Promise<StandaloneToolContext> {
  const { projectRoot, toolName, pipelineId } = options
  const globalContext = await loadGlobalContext(projectRoot)
  const runId = `tool-${randomUUID()}`
  const logger = createStderrLogger()
  const runContext: RunContext = {
    runId,
    pipelineId,
    startedAt: new Date().toISOString(),
    global: globalContext,
    checkpoint: { stepId: 'standalone', depth: 0, path: ['standalone'] },
    logger,
    artifactsDir: join(projectRoot, '.mt', 'runs', runId, 'artifacts'),
  }
  const toolContext: ToolContext = {
    run: runContext,
    step: {
      stepId: `standalone/${toolName}`,
      name: toolName,
      type: 'tool',
      index: 0,
    },
  }
  return { runContext, toolContext, logger }
}
