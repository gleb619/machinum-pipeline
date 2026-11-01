import { definePipeline, defineTool, getVariable, withItem } from '@mt/core'
import { statFreq, toMarkdownTool, tokenCounter, tokenizeWords, wordCounter } from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// Advanced flow: one bespoke tool + a hand-composed pipeline.
//
// This file is the "custom" half of the pair. It shows:
//
// - a hand-written tool (`defineTool`) for the step the package does not ship:
//   turning a JSONL record into prefixed lines
// - waypoints: `jsonl://`, `range://`, `md://`, `void://`, `ephemeral://` and the
//   entity buffers `lines://` / `words://` (packages/waypoint/src/entity-buffers.ts)
// - tools:      `wordCounter`, `tokenCounter`, `statFreq`, `toMarkdownTool` and the
//   word splitter `tokenizeWords` (packages/tools)
// - DSL ops:    `.from` `.use` `.flatMap` `.batch` `.tap` `.fork` `.subflow` `.to`
//
// The basics twin is `pipelines/basic-md-processing.ts`: same job, but the
// bespoke tool below is replaced by the shipped `toMarkdownTool`.
// ---------------------------------------------------------------------------

/** One JSONL record of the sample input. */
interface LineRecord {
  id: number
  text: string
}

/**
 * Bespoke tool: split one record into prefixed line payloads.
 *
 * The record id is kept in the text (`1: First line of the document.`) so the
 * markdown output stays traceable back to the input line.
 *
 * The lines are returned as one newline-joined string; the `.flatMap()` below
 * fans them back into one envelope per line.
 */
const toLinePayloads = defineTool<LineRecord, string>({
  name: 'sample2-to-line-payloads',
  version: '1.0.0',
  mdDescription: 'Split a JSONL record into prefixed line payloads.',
  invoke: async (env, _ctx) => {
    const { id, text } = env.item
    const payload = String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `${id}: ${line}`)
      .join('\n')
    return withItem(env, payload)
  },
})

/** Await helper for the ASYNC step demo. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Stage 1 — LINES
//
// `jsonl://` reads records, `.flatMap()` fans every record out into one envelope
// per line, and `temp://lines/custom-md` parks those envelopes in a process-local
// buffer. Ladder rungs are source-only, so the write goes through `temp://`; the
// next stage reads the same buffer back with `lines://custom-md` and never sees
// the file.
// ---------------------------------------------------------------------------

const lineStage = definePipeline({ id: 'custom-md-lines' })
  .from('jsonl://./jsonl/input.jsonl')
  .use(toLinePayloads)
  .flatMap(async (payload: unknown) => String(payload).split('\n'))
  .to('temp://lines/custom-md')

// ---------------------------------------------------------------------------
// Stage 2 — WORDS
//
// Reads the `lines://` buffer, counts the words of every line with a real
// package tool (`wordCounter` sets the `wordCount` variable), then fans each
// line out into its words with `tokenizeWords` (the package word splitter).
// The words land in the process-local buffer read as `words://custom-md`.
// ---------------------------------------------------------------------------

const wordStage = definePipeline({ id: 'custom-md-words' })
  .from('lines://custom-md')
  .use(wordCounter)
  .flatMap(async (line: unknown) => tokenizeWords(String(line)))
  .to('temp://words/custom-md')

// ---------------------------------------------------------------------------
// Stage 3 — MARKDOWN
//
// The three processing modes, in one stream:
//
// - SYNC    — a `.tap()` without `await`: it observes each envelope and moves on.
// - ASYNC   — a `.tap(async …)` that awaits: the pipeline waits for it, the
//             process does not block.
// - PARALLEL— a tool step. The engine runs up to `defaults.concurrency`
//             envelopes of this step at the same time (4 in samples/sample2/mt.json).
//
// Then two BRANCHES via `.fork()`: a child pipeline per envelope, run one after
// another for that envelope, and the child's result is merged back into the
// parent stream. The first branch turns the line into markdown, the second adds
// an offline word-frequency report without touching the payload.
//
// Finally `md://./output.md` writes one markdown block per line.
// ---------------------------------------------------------------------------

/** Branch 1 — payload branch: the line becomes a markdown document. */
const markdownBranch = definePipeline({ id: 'custom-md-branch-markdown' }).use(toMarkdownTool)

/** Branch 2 — analysis branch: the same line, plus a `statFreq` report. */
const statsBranch = definePipeline({ id: 'custom-md-branch-stats' }).use(statFreq)

const mdStage = definePipeline({ id: 'custom-md-md' })
  .from('lines://custom-md')
  .tap((env) => {
    console.log(JSON.stringify({ stage: 'sync', id: env.id }))
  })
  .tap(async (env) => {
    await sleep(5)
    console.log(JSON.stringify({ stage: 'async', id: env.id }))
  })
  .use(tokenCounter)
  .fork(markdownBranch)
  .fork(statsBranch)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number }>(env, 'statFreq')
    console.log(
      JSON.stringify({
        stage: 'branch',
        id: env.id,
        tokenCount: getVariable<number>(env, 'tokenCount'),
        statWords: report?.totalWords ?? 0,
      }),
    )
  })
  .to('md://./output.md')

// ---------------------------------------------------------------------------
// Stage 4 — WORD STATS
//
// A side stage over the `words://` buffer: `.batch()` groups the words into a
// corpus, `statFreq` ranks them offline (no LLM), and the report is logged.
// ---------------------------------------------------------------------------

const wordStatsStage = definePipeline({ id: 'custom-md-word-stats' })
  .from('words://custom-md')
  .batch(100)
  .use(statFreq)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number; uniqueWords?: number }>(env, 'statFreq')
    console.log(
      JSON.stringify({
        stage: 'word-stats',
        totalWords: report?.totalWords ?? 0,
        uniqueWords: report?.uniqueWords ?? 0,
      }),
    )
  })
  .to('void://')

// ---------------------------------------------------------------------------
// Default: orchestrate the four stages.
//
// Each `.subflow()` declares its own `.from()`, so it is a self-contained stage:
// it runs after the upstream stream is consumed, in declaration order. The
// `lines://` and `words://` buffers live in this process, so the stage
// boundaries stay in memory.
// ---------------------------------------------------------------------------

export default definePipeline({ id: 'custom-md-processing' })
  .subflow(lineStage)
  .subflow(wordStage)
  .subflow(mdStage)
  .subflow(wordStatsStage)

// ---------------------------------------------------------------------------
// range:// demo: generate integers, turn them into lines, count their words,
// then discard everything with void://.
// ---------------------------------------------------------------------------

export const rangeDemoPipeline = definePipeline({ id: 'custom-md-range' })
  .from('range://1..3')
  .flatMap(async (n: unknown) => [`${n}: range value ${n}`])
  .use(wordCounter)
  .tap((env) => {
    console.log(
      JSON.stringify({
        stage: 'range',
        id: env.id,
        wordCount: getVariable<number>(env, 'wordCount'),
      }),
    )
  })
  .to('void://')

// ---------------------------------------------------------------------------
// void:// demo: read the same JSONL source but throw the results away instead
// of writing a file.
// ---------------------------------------------------------------------------

export const voidDemoPipeline = definePipeline({ id: 'custom-md-void' })
  .from('jsonl://./jsonl/input.jsonl')
  .use(toLinePayloads)
  .flatMap(async (payload: unknown) => String(payload).split('\n'))
  .to('void://')

// ---------------------------------------------------------------------------
// Ephemeral target demo: write processed lines to an in-memory buffer.
// The ephemeral:// target is built-in (packages/waypoint/src/ephemeral.ts) and is
// useful for tests and in-process pipelines. It is not persisted across processes.
// ---------------------------------------------------------------------------

export const ephemeralDemoPipeline = definePipeline({ id: 'custom-md-ephemeral' })
  .from('jsonl://./jsonl/input.jsonl')
  .use(toLinePayloads)
  .flatMap(async (payload: unknown) => String(payload).split('\n'))
  .tap((env) => {
    console.log(JSON.stringify({ stage: 'ephemeral', id: env.id }))
  })
  .to('ephemeral://custom-md-buffer')

// ---------------------------------------------------------------------------
// Non-blocking side pipeline: counts words independently of the main flow.
// Run this with `mt run ./pipelines/custom-md-processing.ts --pipeline countSidePipeline`.
// It reads the same JSONL source, counts the corpus in one batch, and writes the
// result to a sidecar JSONL file without blocking or changing the main stream.
// ---------------------------------------------------------------------------

export const countSidePipeline = definePipeline({ id: 'custom-md-counter' })
  .from('jsonl://./jsonl/input.jsonl')
  .use(toLinePayloads)
  .flatMap(async (payload: unknown) => String(payload).split('\n'))
  .batch(1000)
  .use(statFreq)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number; uniqueWords?: number }>(env, 'statFreq')
    console.log(
      JSON.stringify({
        stage: 'counter',
        totalWords: report?.totalWords ?? 0,
        uniqueWords: report?.uniqueWords ?? 0,
      }),
    )
  })
  .to('jsonl://./counts.jsonl')
