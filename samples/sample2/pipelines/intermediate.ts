import { definePipeline, defineTool, withItem, withMeta } from '@mt/core'
import {
  type MarkdownStatsOutput,
  markdownStatsTool,
  readChapterDoc,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// INTERMEDIATE — two lessons in one file.
//
// 1. DECLARE YOUR OWN TOOL. `defineTool()` takes a plain object: an id (`name`),
//    a `version`, an optional `mdDescription`, and `invoke(env)`. `invoke` receives
//    the whole envelope and returns a new one. That is all a tool is — the shipped
//    tools in `@mt/tools` are built exactly this way. A tool may rewrite the item
//    AND stamp `meta`; both are just envelope fields.
//
// 2. SINK A VALUE THROUGH A TARGET WAYPOINT. To write to a file chosen by a
//    variable, the tool stamps `meta.chapter`. The built-in `md://` target has two
//    modes, and the *directory* form (URI that does not end in `.md`) writes one
//    atomic file per envelope, named `chapter<meta.chapter>.md`. So the tool decides
//    the filename by setting `meta.chapter` — no `mdOutputs` intent emitter and no
//    `?series` splitter are involved. The tool says *what*; the waypoint says *where*.
//
// The `.fork()` demo is unchanged: the parent pipeline hands each chapter to three
// steps-only branch pipelines with one core call, and the runner owns the contract
// (isolated clone per branch, concurrent execution, its own checkpoint node per
// parent/branch, buffered output in declaration order, fail-fast after settle).
//
//   jsonl://./jsonl/entities.jsonl
//     → fork('chapter-views', [countBranch, reorderBranch, commasBranch])
//          each branch stamps meta.chapter = "<number>-<view>"
//     → md://./chapters/chapter-views/   (dir mode → chapter<number>-<view>.md)
//
// ---------------------------------------------------------------------------

/**
 * Routing key for the `md://` dir-mode filename `chapter<meta.chapter>.md`.
 * Keeping chapter number and view in one value gives every fork branch its own
 * file — same `chapterNum` across branches would otherwise collide (last write wins).
 */
function routeKey(number: number | undefined, view: string): string {
  return `${number ?? 'x'}-${view}`
}

const renderStats = defineTool<MarkdownStatsOutput, string>({
  name: 'sample2-render-stats',
  version: '1.0.0',
  mdDescription: 'Render markdown stats as the chapter count section.',
  invoke: async (env) => {
    const { text, stats } = env.item
    const doc = readChapterDoc(text)
    const meta = doc.metadata()
    const paragraphs = doc.chapterTree().paragraphs()
    let lines = 0
    for (const paragraph of paragraphs) lines += paragraph.lines.length
    const body = paragraphs
      .map((paragraph) => paragraph.lines.map((line) => line.text).join(' '))
      .join(' ')
    const words = tokenizeWords(body).length
    const title = stats.title ?? doc.chapter.title
    const reviewer = meta.get<string>('reviewer')

    const rendered =
      `# ${title}\n\n## counts\n\n${stats.paragraphs} paragraphs · ${lines} lines · ${words} words\n` +
      `number: ${meta.number ?? 'none'} · series: ${meta.series ?? 'none'}` +
      `${reviewer !== undefined ? ` · reviewer: ${reviewer}` : ''}\n`

    // Stamp the routing value; the `md://` target turns it into the filename.
    return withMeta(withItem(env, rendered), { chapter: routeKey(meta.number, 'counts') })
  },
})

const reorderLines = defineTool<string, string>({
  name: 'sample2-reorder-lines',
  version: '1.0.0',
  mdDescription: 'Parse a markdown chapter and sort every paragraph’s lines alphabetically.',
  invoke: async (env) => {
    const doc = readChapterDoc(env.item)
    const meta = doc.metadata()
    meta.add('lineOrder', 'alphabetical')
    const paragraphs = doc
      .chapterTree()
      .paragraphs()
      .map((paragraph, index) => {
        const ordered = paragraph.lines
          .map((line) => line.text)
          .sort((left, right) => left.localeCompare(right))
        return [`### paragraph ${index + 1}`, '', ...ordered.map((line) => `- ${line}`)].join('\n')
      })

    const rendered = `## lines reordered\n\nlineOrder: ${meta.get('lineOrder')}\n\n${paragraphs.join('\n\n')}\n`
    return withMeta(withItem(env, rendered), { chapter: routeKey(meta.number, 'reordered') })
  },
})

const replaceDots = defineTool<string, string>({
  name: 'sample2-dots-to-commas',
  version: '1.0.0',
  mdDescription: 'Parse a markdown chapter and replace every dot in its body with a comma.',
  invoke: async (env) => {
    const doc = readChapterDoc(env.item)
    const meta = doc.metadata()
    let dotsReplaced = 0
    const body = doc
      .chapterTree()
      .paragraphs()
      .map((paragraph) =>
        paragraph.lines
          .map((line) => {
            const text = line.text
            const matches = text.match(/\./g)
            dotsReplaced += matches?.length ?? 0
            return text.replaceAll('.', ',')
          })
          .join('\n'),
      )
      .join('\n\n')
    meta.add('dotsReplaced', dotsReplaced)

    const rendered = `## dots replaced with commas\n\ndotsReplaced: ${meta.get('dotsReplaced')}\n\n${body}\n`
    return withMeta(withItem(env, rendered), { chapter: routeKey(meta.number, 'commas') })
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
  .to('md://./chapters/chapter-views/')

export default parallelForksPipeline
