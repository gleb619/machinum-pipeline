import {
  type Chapter,
  type Chunk,
  type Line,
  type Paragraph,
  type Target,
  type Token,
  definePipeline,
  defineProcess,
  defineSource,
  defineTarget,
  defineWaypoint,
  getVariable,
} from '@mt/core'
import {
  type ChapterDoc,
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

export const cleanSplitPipeline = definePipeline({ id: 'sample2-chunk-normalization' })
  .subflow(cleanSplitStage)
  .subflow(reuseStage)

interface LadderChapter extends Pick<Chapter, 'title'> {
  number: number
  paragraphs: string[][]
}

type ChunkEntity = Chunk
type ParagraphEntity = Paragraph & { chunkId: string }

interface LineEntity extends Line {
  chapterId: string
  chunkId: string
}

interface WordEntity {
  id: string
  chapterId: string
  chunkId: string
  paragraphId: string
  lineId: string
  word: string
  index: number
}

type TokenEntity = Token

const ladderCounts = {
  records: 0,
  documents: 0,
  chunks: 0,
  paragraphs: 0,
  lines: 0,
  words: 0,
  tokens: 0,
}

const ladderSource = defineWaypoint(defineSource<LadderChapter>('jsonl://./jsonl/ladder.jsonl'), {
  onItem: () => {
    ladderCounts.records += 1
  },
})

function countingTarget<T>(uri: string, key: keyof typeof ladderCounts): Target<T> {
  return defineWaypoint(defineTarget<T>(uri), {
    onOpen: () => {
      ladderCounts[key] = 0
    },
    onWrite: () => {
      ladderCounts[key] += 1
    },
    onClose: () => {
      console.log(`[ladder] ${key}=${ladderCounts[key]}`)
    },
  })
}

function toChapterInput(record: LadderChapter): {
  title: string
  number: number
  body: { lines: string[] }[]
} {
  return {
    number: record.number,
    title: record.title,
    body: record.paragraphs.map((lines) => ({ lines })),
  }
}

function toChunks(doc: ChapterDoc): ChunkEntity[] {
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

function toParagraphs(chunk: ChunkEntity): ParagraphEntity[] {
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

function toLines(paragraph: ParagraphEntity): LineEntity[] {
  return paragraph.body
    .split('\n')
    .map((text, index) => ({
      id: `${paragraph.id}/line-${index + 1}`,
      paragraphId: paragraph.id,
      chapterId: paragraph.chapterId,
      chunkId: paragraph.chunkId,
      index,
      text,
    }))
    .filter((line) => line.text.trim().length > 0)
}

function toWords(line: LineEntity): WordEntity[] {
  return tokenizeWords(line.text).map((word, index) => ({
    id: `${line.id}/word-${index + 1}`,
    chapterId: line.chapterId,
    chunkId: line.chunkId,
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

const documentStage = definePipeline({ id: 'sample2-ladder-documents' })
  .from(ladderSource)
  .flatMap(async (record: unknown) => [toChapterInput(record as LadderChapter)])
  .use(chapterDocBuild)
  .use(chapterIndexer)
  .use(chapterDocEmit)
  .to(countingTarget<string>('md://./chapters/ladder-chapters', 'documents'))

const chunkStage = definePipeline({ id: 'sample2-ladder-chunks' })
  .from('md://./chapters/ladder-chapters')
  .flatMap(async (item: unknown) => toChunks(readChapterDoc(String(item))))
  .to(countingTarget<ChunkEntity>('chunks://ladder', 'chunks'))

const paragraphStage = definePipeline({ id: 'sample2-ladder-paragraphs' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toParagraphs(chunk as ChunkEntity))
  .to(countingTarget<ParagraphEntity>('paragraphs://ladder', 'paragraphs'))

const lineStage = definePipeline({ id: 'sample2-ladder-lines' })
  .from('paragraphs://ladder')
  .flatMap(async (paragraph: unknown) => toLines(paragraph as ParagraphEntity))
  .to(countingTarget<LineEntity>('lines://ladder', 'lines'))

const wordStage = definePipeline({ id: 'sample2-ladder-words' })
  .from('lines://ladder')
  .flatMap(async (line: unknown) => toWords(line as LineEntity))
  .to(countingTarget<WordEntity>('words://ladder', 'words'))

const summaryStage = definePipeline({ id: 'sample2-ladder-summary' })
  .from('words://ladder')
  .batch(10_000)
  .flatMap(async (words: unknown) => [renderLadderSummary((words as WordEntity[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

export const ladderPipeline = definePipeline({ id: 'sample2-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(paragraphStage)
  .subflow(lineStage)
  .subflow(wordStage)
  .subflow(summaryStage)

let tokenHeuristic = false

async function toTokens(chunk: ChunkEntity): Promise<TokenEntity[]> {
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

const tokenStage = definePipeline({ id: 'sample2-ladder-tokens' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toTokens(chunk as ChunkEntity))
  .to(countingTarget<TokenEntity>('tokens://ladder', 'tokens'))

const tokenSummaryStage = definePipeline({ id: 'sample2-ladder-token-summary' })
  .from('tokens://ladder')
  .batch(100_000)
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as TokenEntity[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

export const tokenLadderPipeline = definePipeline({ id: 'sample2-token-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(tokenStage)
  .subflow(tokenSummaryStage)

export const seriesSplitPipeline = definePipeline({ id: 'sample2-series-split' })
  .from('md://./chapters/chapter1.md')
  .use(seriesSplitTool)
  .to('md://./chapters/series-output.md')

const allPipelines = definePipeline({ id: 'sample2-chunk-normalization-suite' })
  .subflow(cleanSplitPipeline)
  .subflow(ladderPipeline)
  .subflow(tokenLadderPipeline)
  .subflow(seriesSplitPipeline)

export default defineProcess()
  .config({ env: { MT_CHUNK_SIZE: String(CHUNK_SIZE) } })
  .pipeline(allPipelines)
