import { definePipeline, defineTool, withItem } from '@mt/core'
import {
  type MarkdownStatsOutput,
  markdownStatsTool,
  readChapterDoc,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// INTERMEDIATE — one chapter, three views, one markdown file.
//
// Every JSONL item is one markdown chapter. The parent pipeline does not fan
// out or run the views itself; it hands the same chapter to three steps-only
// branch pipelines with one core call:
//
//     .fork('chapter-views', [countBranch, reorderBranch, commasBranch])
//
// The runner owns the concurrency contract:
//
//   - each branch gets an isolated, deep-cloned copy of the chapter envelope;
//   - the branches run concurrently for every parent envelope;
//   - each parent/branch gets its own checkpoint node
//     (`<stepId>/fork-<parent>/branch-<branch>`);
//   - branch output is buffered and merged in declaration order, so the file
//     is deterministic even when branches finish at different times;
//   - a failed branch fails the run after every branch has settled.
//
// The branches use the package pieces where they exist: `markdownStatsTool`
// for structure, `readChapterDoc` for paragraphs/lines, and `tokenizeWords`
// for the body word count. Only the rendering glue is local.
// ---------------------------------------------------------------------------

const renderStats = defineTool<MarkdownStatsOutput, string>({
  name: 'sample2-render-stats',
  version: '1.0.0',
  mdDescription: 'Render markdown stats as the chapter count section.',
  invoke: async (env) => {
    const { text, stats } = env.item
    const doc = readChapterDoc(text)
    let lines = 0
    for (const paragraph of doc.body) lines += paragraph.lines.length
    const body = doc.body.map((paragraph) => paragraph.lines.join(' ')).join(' ')
    const words = tokenizeWords(body).length
    const title = stats.title ?? doc.title

    return withItem(
      env,
      `# ${title}\n\n## counts\n\n${stats.paragraphs} paragraphs · ${lines} lines · ${words} words\n`,
    )
  },
})

const reorderLines = defineTool<string, string>({
  name: 'sample2-reorder-lines',
  version: '1.0.0',
  mdDescription: 'Parse a markdown chapter and sort every paragraph’s lines alphabetically.',
  invoke: async (env) => {
    const doc = readChapterDoc(env.item)
    const paragraphs = doc.body.map((paragraph, index) => {
      const ordered = [...paragraph.lines].sort((left, right) => left.localeCompare(right))
      return [`### paragraph ${index + 1}`, '', ...ordered.map((line) => `- ${line}`)].join('\n')
    })

    return withItem(env, `## lines reordered\n\n${paragraphs.join('\n\n')}\n`)
  },
})

const replaceDots = defineTool<string, string>({
  name: 'sample2-dots-to-commas',
  version: '1.0.0',
  mdDescription: 'Parse a markdown chapter and replace every dot in its body with a comma.',
  invoke: async (env) => {
    const doc = readChapterDoc(env.item)
    const body = doc.body
      .map((paragraph) => paragraph.lines.join('\n').replaceAll('.', ','))
      .join('\n\n')

    return withItem(env, `## dots replaced with commas\n\n${body}\n`)
  },
})

// Steps-only pipelines: each branch consumes the parent envelope. The runner
// supplies the isolated chapter copy and the checkpoint node.
const countBranch = definePipeline({ id: 'sample2-intermediate-counts' })
  .use(markdownStatsTool)
  .use(renderStats)
const reorderBranch = definePipeline({ id: 'sample2-intermediate-line-order' }).use(reorderLines)
const commasBranch = definePipeline({ id: 'sample2-intermediate-commas' }).use(replaceDots)

const parallelForksPipeline = definePipeline({ id: 'sample2-intermediate' })
  .from('jsonl://./jsonl/entities.jsonl')
  .fork('chapter-views', [countBranch, reorderBranch, commasBranch])
  .to('md://./chapters/parallel-forks.md')

export default parallelForksPipeline
