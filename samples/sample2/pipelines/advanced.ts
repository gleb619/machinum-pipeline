import { type Word, definePipeline, defineProcess, getVariable } from '@mt/core'
import {
  VAR_CHUNK_COUNT,
  VAR_CHUNK_SEPARATOR,
  chapterDocBuild,
  chapterDocEmit,
  chapterIndexer,
  chunkSplit,
  mdOutputEmitter,
} from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// ADVANCED — chunk splitting, separator reuse, the Structure Ladder and
// the alternative chunks → tokens rung.
// ---------------------------------------------------------------------------

// Ladder rungs are creational: chunks://, paragraphs://, ... are read-only sources.
// A string-form splitter subflow auto-publishes its output into the matching entity
// buffer; the next stage reads it back through the typed rung
// (.subflow('chunks://', 'ladder') -> chunks://ladder).

// Series split runs first: the demo chapter-series.md is partitioned by the
// registered `series` splitter. The process pins the demo target characters.
const seriesSplitFirstStage = definePipeline({ id: 'sample2-advanced-series-first' })
  .from('md://./chapters/chapter-series.md')
  .subflow('series://')
  .to('md://./chapters/series-first-output.md')

// Clean chapter1.md, split into chunks, write chunked.md.
const cleanSplitStage = definePipeline({ id: 'sample2-advanced-clean-split' })
  .from('md://./chapters/chapter1.md')
  .use(chunkSplit)
  .tap(async (env) => {
    console.log(
      JSON.stringify({
        stage: 'clean-split',
        chunkCount: getVariable<number>(env, VAR_CHUNK_COUNT),
        separator: getVariable<string>(env, VAR_CHUNK_SEPARATOR),
      }),
    )
  })
  .to('md://./chapters/chunked.md')

// Read chunked.md back in and split again — chunk reuse via plain files.
const reuseStage = definePipeline({ id: 'sample2-advanced-chunk-reuse' })
  .from('md://./chapters/chunked.md')
  .use(chunkSplit)
  .tap(async (env) => {
    console.log(
      JSON.stringify({
        stage: 'reuse',
        chunkCount: getVariable<number>(env, VAR_CHUNK_COUNT),
        reused: true,
      }),
    )
  })
  .to('md://./chapters/chunked-reused.md')

// Round-trip: split, persist, reload, split again.
export const cleanSplitPipeline = definePipeline({ id: 'sample2-advanced' })
  .subflow(seriesSplitFirstStage)
  .subflow(cleanSplitStage)
  .subflow(reuseStage)

interface LadderRecord {
  number: number
  title: string
  paragraphs: string[][]
}

// Rung counters, bumped by .tap() in each ladder stage.
const ladderCounts = {
  records: 0,
  documents: 0,
  chunks: 0,
  paragraphs: 0,
  lines: 0,
  words: 0,
  tokens: 0,
}

type LadderRung = keyof typeof ladderCounts

const countRung = (rung: LadderRung) => async () => {
  ladderCounts[rung] += 1
}

function logLadderCounts(): void {
  for (const [rung, count] of Object.entries(ladderCounts)) {
    console.log(`[ladder] ${rung}=${count}`)
  }
}

function renderLadderSummary(words: number): string {
  const rows: [string, string, number][] = [
    ['0', 'jsonl://', ladderCounts.records],
    ['1', 'md://', ladderCounts.documents],
    ['2', 'chunks://', ladderCounts.chunks],
    ['3', 'paragraphs://', ladderCounts.paragraphs],
    ['4', 'lines://', ladderCounts.lines],
    ['5', 'words://', ladderCounts.words],
  ]
  const table = rows.map(([rung, scheme, count]) => `| ${rung} | ${scheme} | ${count} |`).join('\n')
  return [
    '# Structure Ladder',
    '',
    '| Rung | Scheme | Units |',
    '| --- | --- | --- |',
    table,
    '',
    `Words in the last rung: ${words}`,
    '',
  ].join('\n')
}

// Rung 0→1: ladder.jsonl records → chapter docs (md://).
const documentStage = definePipeline({ id: 'sample2-advanced-documents' })
  .from('jsonl://./jsonl/ladder.jsonl')
  .tap(countRung('records'))
  .flatMap(async (record: unknown) => {
    const { title, number, paragraphs } = record as LadderRecord
    return [{ title, number, body: paragraphs.map((lines) => ({ lines })) }]
  })
  .use(chapterDocBuild)
  .use(chapterIndexer)
  .use(chapterDocEmit)
  .tap(countRung('documents'))
  .to('md://./chapters/ladder-chapters')

// Rung 2: chapter docs → Chunks (core domain type) with the registered `chunks` splitter.
const chunkStage = definePipeline({ id: 'sample2-advanced-chunks' })
  .from('md://./chapters/ladder-chapters')
  .subflow('chunks://', 'ladder')
  .tap(countRung('chunks'))

// Rung 3: Chunk → Paragraphs, one per blank-line block, via the registered
// `paragraphs` splitter named by the URI scheme; bare `'paragraphs'` is rejected.
const paragraphStage = definePipeline({ id: 'sample2-advanced-paragraphs' })
  .from('chunks://ladder')
  .subflow('paragraphs://', 'ladder')
  .tap(countRung('paragraphs'))

// Rung 4: Paragraph → Lines (non-empty only) with the registered line splitter.
// The URI scheme names the registered `lines` splitter.
const lineStage = definePipeline({ id: 'sample2-advanced-lines' })
  .from('paragraphs://ladder')
  .subflow('lines://', 'ladder')
  .tap(countRung('lines'))

// Rung 5: Line → Words (core Word entities with parent ids).
const wordStage = definePipeline({ id: 'sample2-advanced-words' })
  .from('lines://ladder')
  .subflow('words://', 'ladder')
  .tap(countRung('words'))

// Collect all words, print rung counts, render summary table.
const summaryStage = definePipeline({ id: 'sample2-advanced-summary' })
  .from('words://ladder')
  // Group words into batches so the tail runs once per batch, not once per word:
  // the count log prints once, flatMap gets Word[] (reads .length), and the
  // summary md is emitted a handful of times instead of once per word.
  .batch(10_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (words: unknown) => [renderLadderSummary((words as Word[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

// The Structure Ladder: records → docs → chunks → paragraphs → lines → words.
export const ladderPipeline = definePipeline({ id: 'sample2-advanced-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(paragraphStage)
  .subflow(lineStage)
  .subflow(wordStage)
  .subflow(summaryStage)

function renderTokenSummary(tokens: number): string {
  return [
    '# Token Ladder',
    '',
    '| Rung | Scheme | Units |',
    '| --- | --- | --- |',
    `| 2 | chunks:// | ${ladderCounts.chunks} |`,
    `| alt | tokens:// | ${ladderCounts.tokens} |`,
    '',
    `Tokens in the last rung: ${tokens}`,
    '',
  ].join('\n')
}

// Token rung: reuse ladder chunks, tokenize each into core Tokens.
const tokenStage = definePipeline({ id: 'sample2-advanced-tokens' })
  .from('chunks://ladder')
  .subflow('tokens://', 'ladder')
  .tap(countRung('tokens'))

const tokenSummaryStage = definePipeline({ id: 'sample2-advanced-token-summary' })
  .from('tokens://ladder')
  .batch(100_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as unknown[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

// Same ladder but chunks → tokens instead of the paragraph/line/word rungs.
export const tokenLadderPipeline = definePipeline({ id: 'sample2-advanced-token-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(tokenStage)
  .subflow(tokenSummaryStage)

// All lessons in one process: clean/split, ladder, token ladder.
const allPipelines = definePipeline({ id: 'sample2-advanced-suite' })
  .subflow(cleanSplitPipeline)
  .subflow(ladderPipeline)
  .subflow(tokenLadderPipeline)

// Process entry: pin MT_CHUNK_SIZE and the demo series target so the run is reproducible.
export default defineProcess()
  .config({
    env: {
      MT_CHUNK_SIZE: '40',
      MT_CONST_SERIES_SPLIT_TARGET_CHARS: '150',
    },
  })
  .pipeline(allPipelines)
