import {
  type Chunk,
  type Token,
  type Word,
  definePipeline,
  defineProcess,
  getVariable,
} from '@mt/core'
import {
  VAR_CHUNK_COUNT,
  VAR_CHUNK_SEPARATOR,
  chapterDocBuild,
  chapterDocEmit,
  chapterIndexer,
  chunkSplit,
  mdOutputEmitter,
  tokenizeChunkDetailed,
} from '@mt/tools'
import '@mt/waypoint'

// Chunk normalization: clean/split round-trip, Structure Ladder, token route, series split.
// Ladder default chunk size; MT_CHUNK_SIZE (real env) still wins everywhere.
const CHUNK_SIZE = Number(process.env.MT_CHUNK_SIZE ?? 40)
// Demo series target in characters per part. The splitter resolves the tunable chain
// (first defined wins): `constants` variable -> mt.json
// `settings.constants.SERIES_SPLIT_TARGET_CHARS` -> env
// `MT_CONST_SERIES_SPLIT_TARGET_CHARS` -> shipped `SERIES_SPLIT_TARGET_CHARS`.
const SERIES_TARGET_CHARS = 150

// `--pipeline <name>` runs the named export directly and therefore bypasses the
// `defineProcess()` env defaults below. Seed the same demo values into process.env so
// every entry point (suite or named pipeline) sees them; a real env value still wins.
if (!process.env.MT_CHUNK_SIZE) process.env.MT_CHUNK_SIZE = String(CHUNK_SIZE)
if (!process.env.MT_CONST_SERIES_SPLIT_TARGET_CHARS) {
  process.env.MT_CONST_SERIES_SPLIT_TARGET_CHARS = String(SERIES_TARGET_CHARS)
}

// Ladder rungs are creational: chunks://, paragraphs://, ... are read-only sources.
// A stage writes to the matching temp://<rung>/<namespace> buffer; the next stage
// reads it back through the typed rung (temp://chunks/ladder -> chunks://ladder).

// Series split runs first: the demo chapter-series.md is partitioned by the
// registered `series` splitter. The process pins the demo target characters.
const seriesSplitFirstStage = definePipeline({ id: 'sample2-series-split-first' })
  .from('md://./chapters/chapter-series.md')
  .subflow('#series')
  .to('md://./chapters/series-first-output.md')

// Clean chapter1.md, split into chunks, write chunked.md.
const cleanSplitStage = definePipeline({ id: 'sample2-chunk-clean-split' })
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
const reuseStage = definePipeline({ id: 'sample2-chunk-reuse' })
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
export const cleanSplitPipeline = definePipeline({ id: 'sample2-chunk-normalization' })
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
const documentStage = definePipeline({ id: 'sample2-ladder-documents' })
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
const chunkStage = definePipeline({ id: 'sample2-ladder-chunks' })
  .from('md://./chapters/ladder-chapters')
  .subflow('#chunks')
  .tap(countRung('chunks'))
  .to('temp://chunks/ladder')

// Rung 3: Chunk → Paragraphs, one per blank-line block. `.subflow('#paragraphs')`
// is the shortcut for `.subflow('paragraphs://')`; bare `'paragraphs'` is rejected.
const paragraphStage = definePipeline({ id: 'sample2-ladder-paragraphs' })
  .from('chunks://ladder')
  .subflow('#paragraphs')
  .tap(countRung('paragraphs'))
  .to('temp://paragraphs/ladder')

// Rung 4: Paragraph → Lines (non-empty only) with the registered line splitter.
// The explicit URI form resolves the same splitter as `.subflow('#lines')`.
const lineStage = definePipeline({ id: 'sample2-ladder-lines' })
  .from('paragraphs://ladder')
  .subflow('lines://')
  .tap(countRung('lines'))
  .to('temp://lines/ladder')

// Rung 5: Line → Words (core Word entities with parent ids).
const wordStage = definePipeline({ id: 'sample2-ladder-words' })
  .from('lines://ladder')
  .subflow('#words')
  .tap(countRung('words'))
  .to('temp://words/ladder')

// Collect all words, print rung counts, render summary table.
const summaryStage = definePipeline({ id: 'sample2-ladder-summary' })
  .from('words://ladder')
  .batch(10_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (words: unknown) => [renderLadderSummary((words as Word[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

// The Structure Ladder: records → docs → chunks → paragraphs → lines → words.
export const ladderPipeline = definePipeline({ id: 'sample2-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(paragraphStage)
  .subflow(lineStage)
  .subflow(wordStage)
  .subflow(summaryStage)

let tokenHeuristic = false

async function toTokens(chunk: Chunk): Promise<Token[]> {
  const { tokens, heuristic } = await tokenizeChunkDetailed(chunk.body)
  if (heuristic) tokenHeuristic = true
  return tokens.map((token, index) => ({
    id: `${chunk.id}/token-${index + 1}`,
    chunkId: chunk.id,
    tokenId: token.tokenId,
    text: token.text,
    index,
  }))
}

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
    `Heuristic: ${tokenHeuristic}`,
    '',
  ].join('\n')
}

// Token rung: reuse ladder chunks, tokenize each into core Tokens.
const tokenStage = definePipeline({ id: 'sample2-ladder-tokens' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toTokens(chunk as Chunk))
  .tap(countRung('tokens'))
  .to('temp://tokens/ladder')

const tokenSummaryStage = definePipeline({ id: 'sample2-ladder-token-summary' })
  .from('tokens://ladder')
  .batch(100_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as Token[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

// Same ladder but chunks → tokens instead of the paragraph/line/word rungs.
export const tokenLadderPipeline = definePipeline({ id: 'sample2-token-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(tokenStage)
  .subflow(tokenSummaryStage)

// Series split: `.subflow('#series')` is the shortcut for the registered `series`
// splitter (`series://`). The target can do the same split itself:
// `.to('md://./chapters/series-output.md?series=true')` — then drop the `.subflow(...)`.
export const seriesSplitPipeline = definePipeline({ id: 'sample2-series-split' })
  .from('md://./chapters/chapter1.md')
  .subflow('#series')
  .to('md://./chapters/series-output.md')

// All four lessons in one process: clean/split, ladder, token ladder, series split.
const allPipelines = definePipeline({ id: 'sample2-chunk-normalization-suite' })
  .subflow(cleanSplitPipeline)
  .subflow(ladderPipeline)
  .subflow(tokenLadderPipeline)
  .subflow(seriesSplitPipeline)

// Process entry: pin MT_CHUNK_SIZE and the demo series target so the run is reproducible.
export default defineProcess()
  .config({
    env: {
      MT_CHUNK_SIZE: String(CHUNK_SIZE),
      MT_CONST_SERIES_SPLIT_TARGET_CHARS: String(SERIES_TARGET_CHARS),
    },
  })
  .pipeline(allPipelines)
