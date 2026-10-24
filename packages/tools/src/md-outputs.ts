import { defineTool } from '@mt/core'
import type { Envelope, MdOutputEntry, Tool } from '@mt/core'

/** Append an entry to `meta.mdOutputs` (non-mutating). */
export function appendMdOutput(
  meta: Record<string, unknown>,
  entry: MdOutputEntry,
): Record<string, unknown> {
  const existing = (meta.mdOutputs as MdOutputEntry[] | undefined) ?? []
  return { ...meta, mdOutputs: [...existing, entry] }
}

export interface MdOutputEmitterConfig {
  /** Entry name (e.g. 'schema-doc'). */
  name: string
  /** Target directory, relative to the md:// target root. */
  dir: string
  /** Filename derived from envelope meta. */
  filename: (meta: Record<string, unknown>) => string
  /** Skip emit (pass envelope through) when this returns false. Default: always emit. */
  when?: (meta: Record<string, unknown>) => boolean
  /** Tool name override. Default: `${name}-emit`. */
  toolName?: string
}

/**
 * Reusable emit slot: takes the markdown in `env.item` and appends it to `meta.mdOutputs`
 * so an `md://` target writes it. Swap it (e.g. via `tool.with({ emit })`) to redirect or mock output.
 */
export function mdOutputEmitter(config: MdOutputEmitterConfig): Tool<string, string> {
  return defineTool<string, string>({
    name: config.toolName ?? `${config.name}-emit`,
    version: '1.0.0',
    mdDescription: `Appends item markdown to meta.mdOutputs as '${config.name}' in ${config.dir}.`,
    async invoke(env: Envelope<string>) {
      const meta = env.meta ?? {}
      if (config.when && !config.when(meta)) return env
      return {
        item: env.item,
        meta: appendMdOutput(meta, {
          name: config.name,
          dir: config.dir,
          filename: config.filename(meta),
          content: env.item,
        }),
      }
    },
  })
}
