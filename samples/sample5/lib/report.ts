import { basename } from 'node:path'
import { defineTool, getVariable, setVariable, withItem } from '@mt/core'
import type { Exchange } from '@mt/core'
import { appendMdOutput } from '@mt/tools'

// Every pipeline ends with one `report(...)` step: it writes `out/<tool>/<name>.md` with the
// INPUT and the tool OUTPUT in one file, so the quality can be judged by eye.

/** Remembers the source text in the `input` variable (tools that rewrite `item` would lose it). */
export const keepInput = defineTool<string, string>({
  name: 'keep-input',
  version: '1.0.0',
  mdDescription:
    'Copies the item text (or all batched items) into the input variable for the report.',
  async invoke(env) {
    const input = (env.items ?? [env.item]).join('\n\n---\n\n')
    return setVariable(env, 'input', input)
  },
})

export interface ReportSpec {
  /** Pipeline name, e.g. `summary`. */
  tool: string
  /** Backend used (printed in the report header). */
  llm: { tool: string; model: string }
  /** What the tool produced, as text, plus optional run info (attempts, fallback flag, ...). */
  render: (env: Exchange<unknown>) => { output: string; info?: unknown }
  /** Output file name. Default: the name of the source file. */
  filename?: string
}

/** Wraps text in a fence longer than any fence inside it. */
function fenced(text: string, lang = 'text'): string {
  return `~~~~${lang}\n${text.trimEnd()}\n~~~~`
}

/** Writes the side-by-side report through the `md://` target of the pipeline. */
export function report(spec: ReportSpec) {
  return defineTool<unknown, string>({
    name: `report-${spec.tool}`,
    version: '1.0.0',
    mdDescription: 'Renders input + tool output as one markdown report (mdOutputs).',
    async invoke(env) {
      const source = typeof env.meta.filePath === 'string' ? basename(env.meta.filePath) : undefined
      const filename = spec.filename ?? source ?? `${spec.tool}.md`
      const { output, info } = spec.render(env)
      const input = getVariable<string>(env, 'input') ?? ''
      const md = [
        `# ${spec.tool}${source ? ` - ${source}` : ''}`,
        '',
        `backend: \`${spec.llm.tool}\` - model: \`${spec.llm.model}\``,
        '',
        '## Input',
        '',
        fenced(input),
        '',
        '## Output',
        '',
        fenced(output),
        ...(info === undefined
          ? []
          : ['', '## Run info', '', fenced(JSON.stringify(info, null, 2), 'json')]),
        '',
      ].join('\n')
      return appendMdOutput(withItem(env, md), {
        name: spec.tool,
        subdir: '',
        filename,
        content: md,
      })
    },
  })
}
