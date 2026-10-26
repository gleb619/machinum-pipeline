import { MD_OUTPUTS_VARIABLE, defineTool, getVariable, setVariable } from '@mt/core'
import type { Exchange, MdOutputEntry, Tool } from '@mt/core'

/** Variable carrying `MdOutputEntry[]` write intents for the `md://` target. */
export const VAR_MD_OUTPUTS = MD_OUTPUTS_VARIABLE

/** Append an entry to the `mdOutputs` variable (non-mutating). */
export function appendMdOutput<T>(ex: Exchange<T>, entry: MdOutputEntry): Exchange<T> {
  const existing = getVariable<MdOutputEntry[]>(ex, VAR_MD_OUTPUTS) ?? []
  return setVariable(ex, VAR_MD_OUTPUTS, [...existing, entry])
}

export interface MdOutputEmitterConfig {
  /** Entry name (e.g. 'schema-doc'). */
  name: string
  /**
   * Subfolder under the `md://` target root. Default: `''` (the root itself).
   * Never include the target root or an absolute path — the waypoint owns that.
   */
  subdir?: string
  /** Filename derived from envelope meta (basename only). */
  filename: (meta: Record<string, unknown>) => string
  /** Skip emit (pass envelope through) when this returns false. Default: always emit. */
  when?: (meta: Record<string, unknown>) => boolean
  /** Tool name override. Default: `${name}-emit`. */
  toolName?: string
}

/**
 * Reusable emit slot: takes the markdown in `env.item` and appends a write intent
 * to the `mdOutputs` variable so an `md://` target writes it under its own root.
 * Swap it (e.g. via `tool.with({ emit })`) to redirect or mock output.
 */
export function mdOutputEmitter(config: MdOutputEmitterConfig): Tool<string, string> {
  const subdir = config.subdir ?? ''
  return defineTool<string, string>({
    name: config.toolName ?? `${config.name}-emit`,
    version: '1.0.0',
    mdDescription: `Appends item markdown to the mdOutputs variable as '${config.name}' in ${subdir || '.'}.`,
    async invoke(ex: Exchange<string>) {
      const meta = ex.meta ?? {}
      if (config.when && !config.when(meta)) return ex
      return appendMdOutput(ex, {
        name: config.name,
        subdir,
        filename: config.filename(meta),
        content: ex.item,
      })
    },
  })
}
