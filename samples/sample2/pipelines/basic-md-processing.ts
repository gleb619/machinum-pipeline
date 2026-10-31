import { definePipeline, getVariable } from '@mt/core'
import { statFreq, toMarkdownTool, wordCounter } from '@mt/tools'
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

export default definePipeline({ id: 'basic-md-processing' })
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
  .to('md://./output.md')

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
