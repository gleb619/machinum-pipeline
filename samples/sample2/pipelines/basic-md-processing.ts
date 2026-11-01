import { definePipeline, getVariable } from '@mt/core'
import { chapterDocBuild, readChapterDoc, statFreq, toMarkdownTool, wordCounter } from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// The basics: one source, one shipped tool, one target.
//
// This is the short version of the sample. The advanced flow lives next door in
// `pipelines/custom-md-processing.ts`: there the pipeline is hand-composed —
// custom glue functions, entity buffers (`lines://`, `words://`), `.fork()`
// branches, a parallel step and a non-blocking side pipeline.
//
// Here every processing step is a tool that already ships in `@mt/tools`, so
// the pipeline body is only the three DSL calls you would write first:
//
//     .from(...)  →  .use(tool)  →  .to(...)
//
// Concretely, the custom tool of the advanced version is replaced by shipped
// equivalents:
//
//   custom                                   shipped (this file)
//   -------------------------------------   --------------------------------
//   local `toLinePayloads()` glue function   `toMarkdownTool` (builds markdown)
//   local `sleep()` + `.tap()` counters      `wordCounter` (sets `wordCount`)
//   local word-frequency aggregation         `statFreq` (offline frequency report)
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

export const defaultPipeline = definePipeline({ id: 'basic-md-processing' })
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

export const typedContentPipeline = definePipeline({ id: 'typed-content' })
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
    if (second) second.lines = ['[REWRITTEN PARAGRAPH]']

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
  .to('md://./output-typed.md')

// ---------------------------------------------------------------------------
// Corpus statistics: batch the lines and let `statFreq` rank the words.
//
// `statFreq` is offline (no LLM): it writes a frequency report into the
// `statFreq` variable, which the log line below prints.
// ---------------------------------------------------------------------------

export const statsPipeline = definePipeline({ id: 'basic-md-stats' })
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
// Pick what `mt run` runs (uncomment one; no default export = implicit suite of all 3):
//
// all three, explicit order + mode
// import { defineSuite } from '@mt/core'
// export default defineSuite([defaultPipeline, typedContentPipeline, statsPipeline], {
//   id: 'basic-md-all',
//   mode: 'sync', // or 'parallel'
// })
//
// all three, parallel shorthand
// export default defineSuite([defaultPipeline, typedContentPipeline, statsPipeline]).parallel()
//
// just one pipeline
// export default typedContentPipeline
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Running this file
//
// No default export -> implicit suite `basic-md-processing-suite`: all 3 exported
// pipelines in alphabetical order (defaultPipeline, statsPipeline,
// typedContentPipeline), sync:
//   mt run ./pipelines/basic-md-processing.ts
//
// Default pipeline -> only that one:
//   export default defaultPipeline
//
// Default suite -> exactly that suite (order + mode); see the block above.
//
// `--pipeline <name>` always wins over the default export:
//   mt run ./pipelines/basic-md-processing.ts --pipeline defaultPipeline
//   mt run ./pipelines/basic-md-processing.ts --pipeline typedContentPipeline
//   mt run ./pipelines/basic-md-processing.ts --pipeline statsPipeline
// ---------------------------------------------------------------------------
