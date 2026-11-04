import { relative, resolve } from 'node:path'
import { Runner, importPipelineModule, isPipeline, isPipelineSuite, readMtConfig } from '@mt/core'
import type { GlobalContext, Logger, Pipeline, PipelineSuite } from '@mt/core'

/**
 * Shared runner for `mt.json` lifecycle hook scripts (`scripts.install` /
 * `scripts.start` / `scripts.end` / `scripts.stop` / `scripts.exit` /
 * `scripts.resume` / `scripts.error`). Each script is a pipeline module file
 * relative to the project root, executed with its own Runner against the
 * project's GlobalContext. Absent scripts are a no-op.
 *
 * Hook errors propagate to the caller by default so that `mt install` and
 * `scripts.start` can fail the command. Callers that must not let a hook
 * mask the main outcome (e.g. `scripts.end` / `scripts.exit`) should wrap
 * the call in their own try/catch.
 */

export type LifecycleHookName = 'install' | 'start' | 'end' | 'stop' | 'exit' | 'resume' | 'error'

export interface LifecycleRunOptions {
  /** Logger for progress lines; defaults to the console. */
  logger?: Pick<Logger, 'info' | 'warn'>
}

/** Load the script module for hook `name`; undefined when the hook is not defined. */
async function resolveLifecycleScript(
  ctx: GlobalContext,
  name: LifecycleHookName,
): Promise<{ runnable: Pipeline | PipelineSuite; pipelineFile: string } | undefined> {
  const config = await readMtConfig(ctx.project.root)
  const script = config.scripts?.[name]
  if (!script) return undefined

  const resolvedPath = resolve(ctx.project.root, script)
  let mod: Record<string, unknown>
  try {
    mod = await importPipelineModule(resolvedPath)
  } catch (err) {
    throw new Error(
      `Cannot load lifecycle script '${script}' (${name}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const runnable = (mod.default ?? mod.pipeline) as Pipeline | PipelineSuite | undefined
  if (
    !runnable ||
    !(isPipeline(runnable) || isPipelineSuite(runnable) || isLegacyPipeline(runnable))
  ) {
    throw new Error(
      `Invalid lifecycle script '${script}' (${name}). Expected default export from definePipeline() or defineProcess().`,
    )
  }

  return { runnable, pipelineFile: relative(ctx.project.root, resolvedPath) }
}

/**
 * Run the `scripts.<name>` hook when defined; no-op when absent.
 * Throws with a clear message when the script file is missing or invalid, or
 * when the hook pipeline itself rejects.
 */
export async function runLifecycleScript(
  ctx: GlobalContext,
  name: LifecycleHookName,
  options: LifecycleRunOptions = {},
): Promise<void> {
  const logger = options.logger ?? console
  const script = await resolveLifecycleScript(ctx, name)
  if (!script) return

  logger.info(`Running ${name} hook: ${script.runnable.id} (${script.pipelineFile})`)
  if (isPipelineSuite(script.runnable)) {
    await script.runnable.run(ctx, {
      pipelineFile: script.pipelineFile,
    })
  } else {
    const runner = new Runner(script.runnable, ctx, {
      pipelineFile: script.pipelineFile,
    })
    await runner.start()
  }
  logger.info(`${name} hook completed: ${script.runnable.id}`)
}

function isLegacyPipeline(value: unknown): value is Pipeline {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}
