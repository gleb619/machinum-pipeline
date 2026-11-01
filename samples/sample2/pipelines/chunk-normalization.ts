import {
  type Chunk,
  type Line,
  type Paragraph,
  type Token,
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
  heuristicTokenCount,
  mdOutputEmitter,
  readChapterDoc,
  seriesSplitTool,
  splitIntoChunks,
  tokenizeChunkDetailed,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

// Chunk normalization: clean/split round-trip, Structure Ladder, token route, series split.
// Ladder default chunk size; MT_CHUNK_SIZE (real env) still wins everywhere.
const CHUNK_SIZE = Number(process.env.MT_CHUNK_SIZE ?? 40)

// Ladder rungs are creational: chunks://, paragraphs://, ... are read-only sources.
// A stage writes to the matching temp://<rung>/<namespace> buffer; the next stage
// reads it back through the typed rung (temp://chunks/ladder -> chunks://ladder).

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
  .subflow(cleanSplitStage)
  .subflow(reuseStage)

interface LadderRecord {
  number: number
  title: string
  paragraphs: string[][]
}

interface WordEntity {
  id: string
  paragraphId: string
  lineId: string
  word: string
  index: number
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

function toChunks(doc: ReturnType<typeof readChapterDoc>): Chunk[] {
  const chapterId = `chapter-${doc.number ?? 0}`
  const text = doc.body.map((paragraph) => paragraph.lines.join('\n')).join('\n\n')
  return splitIntoChunks(text, { targetTokens: CHUNK_SIZE }).map((body, index) => ({
    id: `${chapterId}/chunk-${index + 1}`,
    chapterId,
    index,
    body,
    tokens: heuristicTokenCount(body),
  }))
}

function toParagraphs(chunk: Chunk): Paragraph[] {
  return chunk.body
    .split(/\n\n+/)
    .filter((part) => part.trim().length > 0)
    .map((body, index) => ({
      id: `${chunk.id}/paragraph-${index + 1}`,
      chapterId: chunk.chapterId,
      chunkId: chunk.id,
      index,
      body,
    }))
}

function toLines(paragraph: Paragraph): Line[] {
  return paragraph.body
    .split('\n')
    .map((text, index) => ({
      id: `${paragraph.id}/line-${index + 1}`,
      paragraphId: paragraph.id,
      index,
      text,
    }))
    .filter((line) => line.text.trim().length > 0)
}

function toWords(line: Line): WordEntity[] {
  return tokenizeWords(line.text).map((word, index) => ({
    id: `${line.id}/word-${index + 1}`,
    paragraphId: line.paragraphId,
    lineId: line.id,
    index,
    word,
  }))
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

// Rung 2: chapter docs → Chunks (core domain type).
const chunkStage = definePipeline({ id: 'sample2-ladder-chunks' })
  .from('md://./chapters/ladder-chapters')
  .flatMap(async (item: unknown) => toChunks(readChapterDoc(String(item))))
  .tap(countRung('chunks'))
  .to('temp://chunks/ladder')

// Rung 3: Chunk → Paragraphs, one per \n\n block.
const paragraphStage = definePipeline({ id: 'sample2-ladder-paragraphs' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toParagraphs(chunk as Chunk))
  .tap(countRung('paragraphs'))
  .to('temp://paragraphs/ladder')

// Rung 4: Paragraph → Lines (non-empty only).
const lineStage = definePipeline({ id: 'sample2-ladder-lines' })
  .from('paragraphs://ladder')
  .flatMap(async (paragraph: unknown) => toLines(paragraph as Paragraph))
  .tap(countRung('lines'))
  .to('temp://lines/ladder')

// Rung 5: Line → Words (lightweight entities with parent ids).
const wordStage = definePipeline({ id: 'sample2-ladder-words' })
  .from('lines://ladder')
  .flatMap(async (line: unknown) => toWords(line as Line))
  .tap(countRung('words'))
  .to('temp://words/ladder')

// Collect all words, print rung counts, render summary table.
const summaryStage = definePipeline({ id: 'sample2-ladder-summary' })
  .from('words://ladder')
  .batch(10_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (words: unknown) => [renderLadderSummary((words as WordEntity[]).length)])
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

// Split chapter1.md into a series doc.
export const seriesSplitPipeline = definePipeline({ id: 'sample2-series-split' })
  .from('md://./chapters/chapter1.md')
  .use(seriesSplitTool)
  .to('md://./chapters/series-output.md')

// All four lessons in one process: clean/split, ladder, token ladder, series split.
const allPipelines = definePipeline({ id: 'sample2-chunk-normalization-suite' })
  .subflow(cleanSplitPipeline)
  .subflow(ladderPipeline)
  .subflow(tokenLadderPipeline)
  .subflow(seriesSplitPipeline)

// Process entry: pin MT_CHUNK_SIZE so the run is reproducible.
export default defineProcess()
  .config({ env: { MT_CHUNK_SIZE: String(CHUNK_SIZE) } })
  .pipeline(allPipelines)
