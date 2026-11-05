import { access, unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { category, defineTool, setVariable, tool } from '@mt/core'
import type { Exchange, Tool, ToolContext } from '@mt/core'

/** Options for {@link createWaitForFile}. */
export interface WaitForFileOptions {
  /**
   * Latch path. Supports `{item}` (the envelope item as a string) and `{id}` (the
   * envelope id). Relative paths resolve against the project root.
   */
  path: string
  /** Poll interval in ms. Default 100. */
  pollMs?: number
  /** Give up after this many ms. Default 0 = wait forever. */
  timeoutMs?: number
  /** Delete the latch once observed. Default false. */
  consume?: boolean
}

/** Non-retryable: waiting longer cannot make the latch appear any faster. */
class LatchTimeoutError extends Error {
  readonly retryable = false

  constructor(path: string, timeoutMs: number) {
    super(`wait-for-file timed out after ${timeoutMs} ms waiting for ${path}`)
    this.name = 'LatchTimeoutError'
  }
}

function resolveTemplate(template: string, env: Exchange<unknown>): string {
  return template.replaceAll('{item}', String(env.item)).replaceAll('{id}', env.id)
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`wait-for-file: ${label} must be a positive integer, got ${value}`)
  }
  return value
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until a latch file exists, then let the envelope through. Turns a pipeline into
 * a manually paced stream: stop the run (Ctrl-C / `mt resume`), create the latch files,
 * and the resumed run continues where it stopped instead of replaying everything.
 *
 * Sets the `latchFile` variable to the resolved absolute path. Idempotent: observing an
 * existing latch has no side effect unless `consume` is set.
 */
export function createWaitForFile(options: WaitForFileOptions): Tool<unknown, unknown> {
  const pollMs = positiveInteger(options.pollMs, 100, 'pollMs')
  const timeoutMs = options.timeoutMs ?? 0
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`wait-for-file: timeoutMs must be >= 0, got ${timeoutMs}`)
  }
  const consume = options.consume ?? false

  return defineTool<unknown, unknown>({
    name: 'wait-for-file',
    version: '1.0.0',
    idempotent: true,
    mdDescription:
      'Blocks until a latch file exists (path supports `{item}` and `{id}`), then passes the envelope through. Use it to pace a pipeline by hand across `mt pause`/`mt resume`.',
    annotations: [
      tool('TL252', {
        name: 'wait-for-file',
        description: 'Blocks until a latch file exists.',
        refs: [],
      }),
      category(['pipeline']),
    ],
    async invoke(env: Exchange<unknown>, ctx: ToolContext): Promise<Exchange<unknown>> {
      const templated = resolveTemplate(options.path, env)
      const root = ctx.run.global.project.root
      const target = isAbsolute(templated) ? templated : resolve(root, templated)
      ctx.run.logger.info('waiting for latch', { path: target })
      const startedAt = Date.now()
      for (;;) {
        if (await pathExists(target)) break
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          throw new LatchTimeoutError(target, timeoutMs)
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
      }
      if (consume) await unlink(target).catch(() => {})
      ctx.run.logger.info('latch acquired', { path: target })
      return setVariable(env, 'latchFile', target)
    },
  })
}

/** Default: one latch per item under `./latch/`. */
export const waitForFile: Tool<unknown, unknown> = createWaitForFile({
  path: './latch/{item}.latch',
})
