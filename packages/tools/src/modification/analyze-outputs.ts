import { defineTool, getVariable, withItem } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'
import { chapterNumberOf } from '../normalization/glossary-extractor.js'
import { chapterTitle } from '../normalization/heuristic-summary.js'

export interface AnalyzeOutputsOptions {
  /** Subfolder of the per-chapter summaries. Default: `schema`. */
  summaryDir?: string
  /** Subfolder of the tagged copies. Default: `en-tagged`. */
  taggedDir?: string
  /** Glossary file name (target root). Default: `glossary.json`. */
  glossaryFile?: string
  /** Relation graph file name (target root). Default: `glossary.graph.json`. */
  graphFile?: string
  /** Log a one-line stats message. Default: true. */
  log?: boolean
}

/**
 * Turns an analysis batch into `mdOutputs` write intents (for an `md://` target):
 *
 * - `<summaryDir>/chapter<N>.summary.md`  (`# title` + `## Summary` from variable `summaryByItem`)
 * - `<taggedDir>/chapter<N>.md`            (variable `taggedItems`, else the input)
 * - `<glossaryFile>`                       (variable `glossaryJson`)
 * - `<graphFile>`                          (variable `glossaryGraphJson`, when the extractor built one)
 *
 * Run after `heuristicSummaryTool` / `glossaryExtractor` / `termTagger`. Item becomes `''`.
 */
export function createAnalyzeOutputs(options: AnalyzeOutputsOptions = {}) {
  const summaryDir = options.summaryDir ?? 'schema'
  const taggedDir = options.taggedDir ?? 'en-tagged'
  const glossaryFile = options.glossaryFile ?? 'glossary.json'
  const graphFile = options.graphFile ?? 'glossary.graph.json'
  return defineTool<string | string[], string>({
    name: 'analyze-outputs',
    version: '1.0.0',
    mdDescription: `Emits ${summaryDir}/chapter<N>.summary.md, ${taggedDir}/chapter<N>.md, ${glossaryFile} and ${graphFile}.`,
    async invoke(env) {
      const inputs = (env.items ?? [env.item]).flat()
      const summaries = getVariable<string[]>(env, 'summaryByItem') ?? []
      const tagged = getVariable<string[]>(env, 'taggedItems') ?? []
      let out = withItem(env, '')
      inputs.forEach((md, i) => {
        const n = chapterNumberOf(md, i + 1)
        const title = chapterTitle(md) || `Chapter ${n}`
        out = appendMdOutput(out, {
          name: 'summary',
          subdir: summaryDir,
          filename: `chapter${n}.summary.md`,
          content: `# ${title}\n\n## Summary\n\n${summaries[i] ?? ''}\n`,
        })
        out = appendMdOutput(out, {
          name: taggedDir,
          subdir: taggedDir,
          filename: `chapter${n}.md`,
          content: tagged[i] ?? md,
        })
      })
      out = appendMdOutput(out, {
        name: 'glossary',
        subdir: '',
        filename: glossaryFile,
        content: String(getVariable(env, 'glossaryJson') ?? ''),
      })
      const graphJson = getVariable(env, 'glossaryGraphJson')
      if (typeof graphJson === 'string' && graphJson !== '') {
        out = appendMdOutput(out, {
          name: 'glossary-graph',
          subdir: '',
          filename: graphFile,
          content: graphJson,
        })
      }
      if (options.log !== false) {
        const glossary = getVariable<{ terms: unknown[] }>(env, 'glossary')
        console.log(
          `[analyze] ${inputs.length} chapters, ${glossary?.terms.length ?? 0} glossary terms`,
        )
      }
      return out
    },
  })
}

/** Analyze outputs with the default layout (`schema/`, `en-tagged/`, `glossary.json`). */
export const analyzeOutputs = createAnalyzeOutputs()
