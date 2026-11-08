import {
  Chapter,
  chapterTree,
  definePipeline,
  defineProcess,
  getVariable,
  log,
  parseChapterTree,
} from '@mt/core'
import { chapterDocBuild, statFreq, toMarkdownTool, wordCounter } from '@mt/tools'
import '@mt/waypoint'

/**
 * PIPE 01 — the smallest possible pipeline: one source, one shipped tool, one target.
 *
 *     jsonl://./jsonl/beginner.jsonl
 *       → wordCounter      (shipped tool → `wordCount` variable)
 *       → toMarkdownTool   (shipped tool → markdown text)
 *       → md://./chapters/beginner.md
 *
 * Every processing step here already ships in `@mt/tools`, so the pipeline body is only the
 * three DSL calls you would write first: `.from(...)` → `.use(tool)` → `.to(...)`.
 *
 * The other exports of this file show the rest of the beginner toolbox:
 *   - `typedContentPipeline`  — typed chapter content: `parseChapterTree()` + `chapterDocBuild`
 *   - `statsPipeline`         — offline corpus statistics (`statFreq`)
 *   - `consolePreviewPipeline` — `console://`, a target that writes every envelope to stdout
 *   - `beginnerSuite`         — an explicit suite: several pipes, one run, in order
 */

/** One JSONL record of the sample input. */
interface LineRecord {
  id: number
  text: string
}

/**
 * Minimal data glue: a JSONL record is not markdown yet.
 *
 * `toMarkdownTool` accepts a plain string as its body, so the record text is enough — the
 * `id` only travels along for the log line.
 */
function toLineText(record: unknown): string {
  const { text } = record as LineRecord
  return String(text)
}

export const defaultPipeline = definePipeline({ id: 'pipe01-beginning' })
  .from('jsonl://./jsonl/beginner.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .use(wordCounter)
  .use(toMarkdownTool)
  .tap((env) => {
    log.info('pipe01 beginner', {
      id: env.id,
      wordCount: getVariable<number>(env, 'wordCount') ?? 0,
    })
  })
  .to('md://./chapters/beginner.md')

/**
 * Typed chapter content manipulation.
 *
 * `parseChapterTree()` wraps a markdown chapter in the fluent `chapterTree()` view: mutate
 * fields through chunk/paragraph/line navigation and serialise back to markdown with the
 * shipped `chapterDocBuild` tool. `parseChapterTree` needs an H1, so the first step mints one
 * from the record id.
 */
export const typedContentPipeline = definePipeline({ id: 'pipe01-typed-content' })
  .from('jsonl://./jsonl/beginner.jsonl')
  .flatMap(async (record: unknown) => {
    const { id } = record as LineRecord
    return [`# Line ${id}\n\n${toLineText(record)}`]
  })
  .flatMap(async (md: string) => {
    const tree = parseChapterTree(md, { id: 'typed-content', meta: { bookId: 'sample1-tutorial' } })

    // 1. Change the title — prepend a tag.
    tree.title = `Edited: ${tree.title}`

    // 2. Edit the first chunk's first paragraph's first line.
    const firstChunk = tree.chunks()[0]
    const firstLine = firstChunk?.paragraphs()[0]?.lines[0]
    if (firstLine) firstLine.text = firstLine.text.toUpperCase()

    // 3. Replace the second paragraph's text.
    firstChunk?.paragraphs()[1]?.setText('<REWRITTEN PARAGRAPH>')

    // Return the mutated tree as the shape expected by `chapterDocBuild`.
    return [{ title: tree.title, body: tree.content }]
  })
  .use(chapterDocBuild)
  .tap((env) => {
    const doc = getVariable<{ chapter: { title: string; content: string } }>(env, 'chapterDoc')
    log.info('pipe01 typed', {
      id: env.id,
      title: doc?.chapter.title ?? '[unknown]',
      paragraphs: doc?.chapter.content.split(/\n\s*\n/).filter((p) => p.length > 0).length ?? 0,
    })
  })
  .to('md://./chapters/output-typed.md')

/**
 * Typed chapter content built from the core `Chapter` type instead of a markdown string.
 */
export const chapterDomainPipeline = definePipeline({ id: 'pipe01-chapter-domain' })
  .from('jsonl://./jsonl/beginner.jsonl')
  .flatMap(async (record: unknown) => {
    const { id } = record as LineRecord
    const chapter = new Chapter({
      id: String(id),
      meta: { bookId: 'sample1-tutorial' },
      text: `# Line ${id}\n\n${toLineText(record)}`,
    })
    const tree = chapterTree(chapter)
    const firstLine = tree.chunks()[0]?.paragraphs()[0]?.lines[0]
    if (firstLine) firstLine.text = `Edited: ${firstLine.text}`
    return [{ title: tree.title, body: tree.content }]
  })
  .use(chapterDocBuild)
  .to('md://./chapters/output-custom-typed.md')

/**
 * Corpus statistics: batch the lines and let `statFreq` rank the words.
 *
 * `statFreq` is offline (no LLM): it writes a frequency report into the `statFreq` variable,
 * which the log line below prints.
 */
export const statsPipeline = definePipeline({ id: 'pipe01-stats' })
  .from('jsonl://./jsonl/beginner.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .batch(100)
  .use(statFreq)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number; uniqueWords?: number }>(env, 'statFreq')
    log.info('pipe01 stats', {
      totalWords: report?.totalWords ?? 0,
      uniqueWords: report?.uniqueWords ?? 0,
    })
  })
  .to('void://')

/**
 * Console preview: inspect each record in the terminal as it flows through.
 *
 * `console://` is a target-only waypoint: every envelope is written to stdout immediately, so
 * this pipe is useful for spotting input problems without creating an output file.
 */
export const consolePreviewPipeline = definePipeline({ id: 'pipe01-console-preview' })
  .from('jsonl://./jsonl/beginner.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .to('console://?prefix=[preview] ')

/**
 * An explicit suite: several pipes, one run, in declaration order.
 *
 *   mt run ./pipelines/pipe01-beginning.ts --pipeline beginnerSuite
 *
 * `.parallel(true)` runs the members side by side instead of one after another.
 */
export const beginnerSuite = defineProcess(
  [
    defaultPipeline,
    typedContentPipeline,
    chapterDomainPipeline,
    statsPipeline,
    consolePreviewPipeline,
  ],
  { id: 'pipe01-suite' },
).parallel(true)

export default defaultPipeline
