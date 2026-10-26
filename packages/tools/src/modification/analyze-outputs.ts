import { defineTool } from '@mt/core'
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
 * Turns an analysis batch into `meta.mdOutputs` write intents (for an `md://` target):
 *
 * - `<summaryDir>/chapter<N>.summary.md`  (`# title` + `## Summary` from `meta.summaryByItem`)
 * - `<taggedDir>/chapter<N>.md`            (`meta.taggedItems`, else the input)
 * - `<glossaryFile>`                       (`meta.glossaryJson`)
 * - `<graphFile>`                          (`meta.glossaryGraphJson`, when the extractor built one)
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
      const summaries = (env.meta.summaryByItem as string[] | undefined) ?? []
      const tagged = (env.meta.taggedItems as string[] | undefined) ?? []
      let meta: Record<string, unknown> = { ...env.meta }
      inputs.forEach((md, i) => {
        const n = chapterNumberOf(md, i + 1)
        const title = chapterTitle(md) || `Chapter ${n}`
        meta = appendMdOutput(meta, {
          name: 'summary',
          subdir: summaryDir,
          filename: `chapter${n}.summary.md`,
          content: `# ${title}\n\n## Summary\n\n${summaries[i] ?? ''}\n`,
        })
        meta = appendMdOutput(meta, {
          name: taggedDir,
          subdir: taggedDir,
          filename: `chapter${n}.md`,
          content: tagged[i] ?? md,
        })
      })
      meta = appendMdOutput(meta, {
        name: 'glossary',
        subdir: '',
        filename: glossaryFile,
        content: String(env.meta.glossaryJson ?? ''),
      })
      const graphJson = env.meta.glossaryGraphJson
      if (typeof graphJson === 'string' && graphJson !== '') {
        meta = appendMdOutput(meta, {
          name: 'glossary-graph',
          subdir: '',
          filename: graphFile,
          content: graphJson,
        })
      }
      if (options.log !== false) {
        const glossary = env.meta.glossary as { terms: unknown[] } | undefined
        console.log(
          `[analyze] ${inputs.length} chapters, ${glossary?.terms.length ?? 0} glossary terms`,
        )
      }
      return { item: '', meta }
    },
  })
}

/** Analyze outputs with the default layout (`schema/`, `en-tagged/`, `glossary.json`). */
export const analyzeOutputs = createAnalyzeOutputs()
