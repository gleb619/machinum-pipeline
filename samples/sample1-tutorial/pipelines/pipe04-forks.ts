import {
  type BusEvent,
  definePipeline,
  defineProcess,
  defineTool,
  emitEvent,
  log,
  withItem,
  withMeta,
} from '@mt/core'
import {
  type MarkdownStatsOutput,
  markdownStatsTool,
  readChapterDoc,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

/**
 * PIPE 04 — parallel branches with `.fork()`.
 *
 * The parent pipeline hands every chapter to three steps-only branch pipelines:
 *
 *   jsonl://./jsonl/entities.jsonl
 *     → .fork(countBranch, reorderBranch, commasBranch)
 *          each branch's `.use(tool, paramsFn)` stamps `meta.chapter = "<number>-<view>"`
 *     → md://./chapters/chapter-views/   (dir mode → chapter<number>-<view>.md)
 *
 * The runner owns the fork contract: an isolated envelope clone per branch, concurrent
 * execution, a checkpoint per parent/branch, and buffered output in declaration order.
 * A branch is a normal pipeline — the only difference is that it starts with `.use(...)`.
 * The routing meta is stamped by the per-`.use()` params fn (it sees the incoming
 * exchange, and `withItem` inside the tool carries meta through), so the tool bodies
 * stay pure renderers.
 */

/** Routing key for the dir-mode filename `chapter<meta.chapter>.md`. */
function routeKey(number: number | undefined, view: string): string {
  return `${number ?? 'x'}-${view}`
}

/** Chapter number from a chapter doc's metadata, for the `routeKey` stamp. */
function chapterNumber(text: string): number | undefined {
  return readChapterDoc(text).metadata().number
}

const renderStats = defineTool<MarkdownStatsOutput, string>({
  name: 'pipe04-render-stats',
  version: '1.0.0',
  mdDescription: 'Renders markdown statistics as a chapter view.',
  async invoke(env) {
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

    return withItem(env, rendered)
  },
})

const reorderLines = defineTool<string, string>({
  name: 'pipe04-reorder-lines',
  version: '1.0.0',
  mdDescription: 'Parses a chapter and sorts every paragraph’s lines alphabetically.',
  async invoke(env) {
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
    return withItem(env, rendered)
  },
})

const replaceDots = defineTool<string, string>({
  name: 'pipe04-dots-to-commas',
  version: '1.0.0',
  mdDescription: 'Parses a chapter and replaces every dot in its body with a comma.',
  async invoke(env) {
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
    return withItem(env, rendered)
  },
})

const countBranch = definePipeline({ id: 'pipe04-counts' })
  .use(markdownStatsTool)
  .use(renderStats, (env) =>
    withMeta(env, { chapter: routeKey(chapterNumber(env.item.text), 'counts') }),
  )
const reorderBranch = definePipeline({ id: 'pipe04-line-order' }).use(reorderLines, (env) =>
  withMeta(env, { chapter: routeKey(chapterNumber(env.item), 'reordered') }),
)
const commasBranch = definePipeline({ id: 'pipe04-commas' }).use(replaceDots, (env) =>
  withMeta(env, { chapter: routeKey(chapterNumber(env.item), 'commas') }),
)

export const parallelForksPipeline = definePipeline({ id: 'pipe04-forks' })
  .from('jsonl://./jsonl/entities.jsonl')
  .fork(countBranch, reorderBranch, commasBranch)
  .to('md://./chapters/chapter-views/')

/**
 * PIPE 04 (events) — a publisher and a subscriber in one process.
 *
 * The publisher announces every chapter on the `chapterReady` channel with a SMALL payload
 * (the chapter number and title — not the whole envelope), the subscriber listens to that
 * channel and logs what arrives. Both pipelines run in ONE process, so they share the
 * process-wide event bus.
 *
 * The subscriber ends on its own: the publisher's run ends, the channel closes, and the
 * subscriber's live stream finishes.
 */
const eventsPublisher = definePipeline({ id: 'pipe04-events-publisher' })
  .from('jsonl://./jsonl/entities.jsonl')
  .tap((env) => {
    if (typeof env.item !== 'string') return
    const doc = readChapterDoc(env.item)
    emitEvent('chapterReady', { chapter: doc.metadata().number ?? 0, title: doc.chapter.title })
  })
  .to('void://')

const eventsSubscriber = definePipeline({ id: 'pipe04-events-subscriber' })
  .from('events://chapterReady')
  .tap((env) => {
    const event = env.item as BusEvent
    const payload = event.payload as { chapter?: number; title?: string } | undefined
    log.info('pipe04 chapter ready', { chapter: payload?.chapter, title: payload?.title })
  })
  .to('void://')

export const eventsSuite = defineProcess([eventsPublisher, eventsSubscriber], {
  id: 'pipe04-events',
}).parallel(true)

export default parallelForksPipeline
