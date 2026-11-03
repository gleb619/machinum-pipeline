import { definePipeline, getVariable } from '@mt/core'
import type { Chapter } from '@mt/core'
import { chapterDocBuild, readChapterDoc, statFreq, toMarkdownTool, wordCounter } from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// The basics: one source, one shipped tool, one target.
//
// This is the short version of the sample. The parallel-branch demo lives next
// door in `pipelines/parallel-forks-md-processing.ts`: each JSONL item is a
// markdown chapter, and three tool-based branch pipelines run concurrently
// through core `.fork('chapter-views', [...])`, all writing to one markdown target.
//
// Here every processing step is a tool that already ships in `@mt/tools`, so
// the pipeline body is only the three DSL calls you would write first:
//
//     .from(...)  →  .use(tool)  →  .to(...)
// ---------------------------------------------------------------------------

/** One JSONL record of the sample input. */
interface LineRecord {
  id: number
  text: string
}

/**
 * Minimal data glue: a JSONL record is not markdown yet.
 *
 * `toMarkdownTool` accepts a plain string as its body, so the record text is
 * enough — the `id` only travels along for the log line.
 */
function toLineText(record: unknown): string {
  const { text } = record as LineRecord
  return String(text)
}

// ---------------------------------------------------------------------------
// Default: read JSONL → count the words → write one markdown block per record.
//
// - `wordCounter` is a shipped tool: it sets the `wordCount` variable.
// - `toMarkdownTool` is a shipped tool: it turns the text into markdown.
// - `md://` is a shipped target: one markdown document per envelope.
// ---------------------------------------------------------------------------

const defaultPipeline = definePipeline({ id: 'basic-md-processing' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .use(wordCounter)
  .use(toMarkdownTool)
  .tap((env) => {
    console.log(
      JSON.stringify({
        stage: 'basic',
        id: env.id,
        wordCount: getVariable<number>(env, 'wordCount') ?? 0,
      }),
    )
  })
  .to('md://./chapters/output.md')

// ---------------------------------------------------------------------------
// Typed chapter content manipulation example.
//
// Demonstrates parsing a markdown chapter into a typed `ChapterDoc`, mutating
// fields, and serialising back to markdown with the shipped `chapterDocBuild`
// tool. `readChapterDoc` requires an H1, so the first step mints one from the
// record id.
// ---------------------------------------------------------------------------

const typedContentPipeline = definePipeline({ id: 'typed-content' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id } = record as LineRecord
    // `readChapterDoc` requires an H1 — mint one from the record id. The body is the
    // record text, exactly what `toMarkdownTool` would have produced for it.
    return [`# Line ${id}\n\n${toLineText(record)}`]
  })
  .flatMap(async (md: string) => {
    // Parse markdown into a typed document.
    const doc = readChapterDoc(md)

    // 1. Change the title - prepend a tag.
    const newTitle = `Edited: ${doc.title}`

    // 2. Upper-case the first paragraph's lines.
    const first = doc.body[0]
    if (first) first.lines = first.lines.map((ln) => ln.toUpperCase())

    const second = doc.body[1]
    if (second) second.lines = ['<REWRITTEN PARAGRAPH>']

    // Return the mutated doc as the shape expected by `chapterDocBuild`.
    const input = {
      title: newTitle,
      body: doc.body,
      number: doc.number,
      series: doc.series,
      warnings: doc.warnings,
    }
    return [input]
  })
  .use(chapterDocBuild)
  .tap((env) => {
    const doc = getVariable<{ title: string; body: { lines: string[] }[] }>(env, 'chapterDoc')
    console.log(
      JSON.stringify({
        stage: 'typed',
        id: env.id,
        title: doc?.title ?? '[unknown]',
        paragraphs: doc?.body.length ?? 0,
      }),
    )
  })
  .to('md://./chapters/output-typed.md')

// ---------------------------------------------------------------------------
// Typed chapter content using existing domain types (Chapter).
// ---------------------------------------------------------------------------

const chapterDomainPipeline = definePipeline({ id: 'chapter-domain-content' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id } = record as LineRecord
    const chapter: Chapter = {
      id: String(id),
      bookId: 'basic-md',
      title: `Line ${id}`,
      body: toLineText(record),
    }
    return [`# ${chapter.title}\n\n${chapter.body}\n`]
  })
  .to('md://./chapters/output-custom-typed.md')

// ---------------------------------------------------------------------------
// Corpus statistics: batch the lines and let `statFreq` rank the words.
//
// `statFreq` is offline (no LLM): it writes a frequency report into the
// `statFreq` variable, which the log line below prints.
// ---------------------------------------------------------------------------

const statsPipeline = definePipeline({ id: 'basic-md-stats' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .batch(100)
  .use(statFreq)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number; uniqueWords?: number }>(env, 'statFreq')
    console.log(
      JSON.stringify({
        stage: 'stats',
        totalWords: report?.totalWords ?? 0,
        uniqueWords: report?.uniqueWords ?? 0,
      }),
    )
  })
  .to('void://')

// ---------------------------------------------------------------------------
// Console preview: inspect each record in the terminal as it flows through.
//
// `console://` is a target-only waypoint: every envelope is written to stdout
// immediately, so this pipeline is useful for spotting input problems without
// creating an output file.
// ---------------------------------------------------------------------------

const consolePreviewPipeline = definePipeline({ id: 'basic-md-console-preview' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => [toLineText(record)])
  .to('console://?prefix=[preview] ')

// all five -> implicit suite (alphabetical, sync)
export {
  chapterDomainPipeline,
  consolePreviewPipeline,
  defaultPipeline,
  statsPipeline,
  typedContentPipeline,
}

// explicit suite -> your order + mode (defineProcess([...]).parallel(true))
import { defineProcess } from '@mt/core'
export default defineProcess([
  defaultPipeline,
  chapterDomainPipeline,
  typedContentPipeline,
  statsPipeline,
  consolePreviewPipeline,
]).parallel(true)

// sync shorthand (default mode is sync)
// export default defineProcess([defaultPipeline, typedContentPipeline, statsPipeline], {
//   id: 'basic-md-all',
// })

// ---------------------------------------------------------------------------
// What runs:
//   no default export  -> implicit suite `basic-md-processing-suite`: all exported
//                         pipelines, alphabetical, sync
//   default pipeline   -> only that one
//   default suite      -> exactly that suite (order + mode)
//   --pipeline <name>  -> that export, always wins (pipeline or suite)
//
//   mt run ./pipelines/basic-md-processing.ts
//   mt run ./pipelines/basic-md-processing.ts --pipeline defaultPipeline
//   mt run ./pipelines/basic-md-processing.ts --pipeline typedContentPipeline
//   mt run ./pipelines/basic-md-processing.ts --pipeline statsPipeline
//   mt run ./pipelines/basic-md-processing.ts --pipeline consolePreviewPipeline
// ---------------------------------------------------------------------------
