import { relative, resolve } from 'node:path'
import { Runner, importPipelineModule, readMtConfig } from '@mt/core'
import type { GlobalContext, Logger, Pipeline } from '@mt/core'

/**
 * Shared runner for `mt.json` lifecycle hook scripts (`scripts.install` /
 * `scripts.start` / `scripts.end`). Each script is a pipeline module file
 * relative to the project root, executed with its own Runner against the
 * project's GlobalContext. Absent scripts are a no-op.
 */

export type LifecycleHookName = 'install' | 'start' | 'end'

export interface LifecycleRunOptions {
  /** Named export to pick from the script module (default: `default` ?? `pipeline`). */
  pipelineName?: string
  /** Logger for progress lines; defaults to the console. */
  logger?: Pick<Logger, 'info' | 'warn'>
}

/** Load the script module for hook `name`; undefined when the hook is not defined. */
async function resolveLifecycleScript(
  ctx: GlobalContext,
  name: LifecycleHookName,
  pipelineName?: string,
): Promise<{ pipeline: Pipeline; pipelineFile: string } | undefined> {
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

  const pipeline = (pipelineName ? mod[pipelineName] : (mod.default ?? mod.pipeline)) as
    | Pipeline
    | undefined
  if (!pipeline || typeof pipeline.id !== 'string') {
    const hint = pipelineName ? ` (named export '${pipelineName}' not found or invalid)` : ''
    throw new Error(
      `Invalid lifecycle script '${script}' (${name}). Expected ${pipelineName ? `export const ${pipelineName}` : 'default export'} from definePipeline().${hint}`,
    )
  }

  return { pipeline, pipelineFile: relative(ctx.project.root, resolvedPath) }
}

/**
 * Run the `scripts.<name>` hook when defined; no-op when absent.
 * Throws with a clear message when the script file is missing or invalid.
 */
export async function runLifecycleScript(
  ctx: GlobalContext,
  name: LifecycleHookName,
  options: LifecycleRunOptions = {},
): Promise<void> {
  const logger = options.logger ?? console
  const script = await resolveLifecycleScript(ctx, name, options.pipelineName)
  if (!script) return

  logger.info(`Running ${name} hook: ${script.pipeline.id} (${script.pipelineFile})`)
  const runner = new Runner(script.pipeline, ctx, {
    pipelineFile: script.pipelineFile,
    pipelineName: options.pipelineName,
  })
  await runner.start()
  logger.info(`${name} hook completed: ${script.pipeline.id}`)
}
