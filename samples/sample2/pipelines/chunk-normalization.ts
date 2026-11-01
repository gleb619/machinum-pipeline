import {
  type Chapter,
  type Chunk,
  type Line,
  type Paragraph,
  type Target,
  type Token,
  definePipeline,
  defineSource,
  defineTarget,
  defineWaypoint,
  getVariable,
} from '@mt/core'
import {
  type ChapterDoc,
  VAR_CHUNK_SEPARATOR,
  chapterDocBuild,
  chapterDocEmit,
  chapterIndexer,
  chunkClean,
  createChunkSplit,
  heuristicTokenCount,
  mdOutputEmitter,
  parseChunks,
  readChapterDoc,
  seriesSplitTool,
  splitIntoChunks,
  tokenizeChunkDetailed,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// Chunk normalization — the `---` separator round-trip and the Structure Ladder.
//
// Two pipelines, both built from shipped pieces only:
//
// - `cleanSplitPipeline` (the default export): a markdown chapter is cleaned of
//   its decorative `---` lines, split into token-bounded chunks and written back
//   with `---` between the chunks. A second stage reads that output again and
//   shows separator reuse: the chunks stay exactly the same.
// - `ladderPipeline`: the Structure Ladder — a JSONL record becomes a markdown
//   document, and every rung below it (chunks, paragraphs, lines, words) is one
//   envelope per unit, handed over through an entity buffer.
//
// The only local code is data glue inside `.flatMap()` (how a document becomes
// chunks, paragraphs, lines and words) and logging inside `.tap()`.
// ---------------------------------------------------------------------------

/**
 * Chunk size in tokens.
 *
 * `chunkSplit` resolves the size as `meta.chunkSize` → tool option → mt.json
 * `settings.chunkSize` → `MT_CHUNK_SIZE` → 6000. The sample pins the tool
 * option so one chapter always splits into several chunks; `MT_CHUNK_SIZE`
 * still wins when it is set (`MT_CHUNK_SIZE=100 pnpm run runner:chunks`).
 */
const CHUNK_SIZE = Number(process.env.MT_CHUNK_SIZE ?? 40)

/** The chunk splitter used by both stages of the clean/split pipeline. */
const chunkSplitter = createChunkSplit({ chunkSize: CHUNK_SIZE })

// ---------------------------------------------------------------------------
// The chunk-count header
//
// The `md://` target writes the payload verbatim — it has no frontmatter of its
// own — so the sample puts the chunk count into the markdown itself, as a
// comment header. The header is stripped again before the next split, so it is
// never counted as content and a re-run stays byte-identical.
// ---------------------------------------------------------------------------

/** Remove a chunk-count header (and the blank lines behind it) from a text. */
function stripChunkHeader(text: string): string {
  return text.replace(/^\s*<!--\s*chunkCount:\s*\d+\s*-->\s*\n+/, '')
}

/** Prefix a chunked text with the chunk-count header. */
function stampChunkHeader(text: string, chunkCount: number): string {
  return `<!-- chunkCount: ${chunkCount} -->\n\n${stripChunkHeader(text).trimEnd()}`
}

// ---------------------------------------------------------------------------
// Stage 1 — CLEAN + SPLIT
//
// `md://` reads the chapter as one envelope. `chunkClean` drops the decorative
// `---` lines (and every other decorative-only line), `chunkSplit` cuts the
// text into token-bounded chunks and writes them back with `---` between them.
// The chunk count lands in `meta.chunkCount` and in the `chunkCount` variable.
//
// The `md://` directory target owns the output folder: `mdOutputEmitter` only
// names the file, the target creates `out/` and writes `out/chunked.md`.
// ---------------------------------------------------------------------------

/** Write the chunked text as `out/chunked.md`. */
const emitChunked = mdOutputEmitter({ name: 'chunked', filename: () => 'chunked.md' })

/** Write the chunked text of the second run as `out/chunked-reused.md`. */
const emitChunkedReused = mdOutputEmitter({
  name: 'chunked-reused',
  filename: () => 'chunked-reused.md',
})

const cleanSplitStage = definePipeline({ id: 'sample2-chunk-clean-split' })
  .from('md://./chapters/chapter1.md')
  .use(chunkClean)
  .use(chunkSplitter)
  .tap(async (env) => {
    console.log(
      JSON.stringify({
        stage: 'clean-split',
        chunkCount: env.meta.chunkCount,
        separator: getVariable<string>(env, VAR_CHUNK_SEPARATOR),
      }),
    )
  })
  // The header carries the same count the tool put into the exchange meta:
  // both are `parseChunks()` of the very same text.
  .flatMap(async (item: unknown) => {
    const text = String(item)
    return [stampChunkHeader(text, parseChunks(text).length)]
  })
  .use(emitChunked)
  .to('md://./chapters')

// ---------------------------------------------------------------------------
// Stage 2 — REUSE
//
// The same splitter, one stage later: the input already carries `---`
// separators, so the splitter keeps the chunks as they are instead of cutting
// them again. The result is the file of stage 1, unchanged.
// ---------------------------------------------------------------------------

const reuseStage = definePipeline({ id: 'sample2-chunk-reuse' })
  .from('md://./chapters/chunked.md')
  .flatMap(async (item: unknown) => [stripChunkHeader(String(item))])
  .use(chunkSplitter)
  .tap(async (env) => {
    console.log(JSON.stringify({ stage: 'reuse', chunkCount: env.meta.chunkCount, reused: true }))
  })
  .flatMap(async (item: unknown) => {
    const text = String(item)
    return [stampChunkHeader(text, parseChunks(text).length)]
  })
  .use(emitChunkedReused)
  .to('md://./chapters')

/**
 * Clean + split a chapter, then run the result through the splitter again.
 *
 * The two stages are `.subflow()`s: each one declares its own `.from()`, so each
 * one is self-contained and runs in declaration order. The entity buffers are not
 * needed here — the handoff between the stages is the markdown file itself.
 */
export const cleanSplitPipeline = definePipeline({ id: 'sample2-chunk-normalization' })
  .subflow(cleanSplitStage)
  .subflow(reuseStage)

export default cleanSplitPipeline

// ---------------------------------------------------------------------------
// The Structure Ladder
//
//   jsonl://      record     → markdown document
//   md://         document   → Chunk entities (token-bounded, `---` units)
//   chunks://                → Paragraph entities (carrying `chunkId`)
//   paragraphs://            → Line entities
//   lines://                 → Word entities
//   words://                 → the summary
//
// Every step down the ladder is one `.flatMap()` (one envelope in, many out)
// plus one entity buffer (many in, one buffer). The buffers are built in — the
// pipeline only uses them, it does not define them.
// ---------------------------------------------------------------------------

/** JSONL record of the ladder demo: a chapter and its paragraphs. */
interface LadderChapter extends Pick<Chapter, 'title'> {
  number: number
  paragraphs: string[][]
}

/** Chunk entity — the core type plus the lines of its text. */
type ChunkEntity = Chunk

/** Paragraph entity — the core type; `chunkId` points at the chunk it belongs to. */
type ParagraphEntity = Paragraph & { chunkId: string }

/** Line entity — the core type plus the chunk and chapter it came from. */
interface LineEntity extends Line {
  chapterId: string
  chunkId: string
}

/** Word entity — `Word` is not a core domain type, so the demo declares one. */
interface WordEntity {
  id: string
  chapterId: string
  chunkId: string
  paragraphId: string
  lineId: string
  word: string
  index: number
}

/** Token entity — the core type; `chunkId` points at the chunk it was derived from. */
type TokenEntity = Token

/** Counts per rung of the ladder, filled by the counting waypoints below. */
const ladderCounts = {
  records: 0,
  documents: 0,
  chunks: 0,
  paragraphs: 0,
  lines: 0,
  words: 0,
  tokens: 0,
}

/** Count the records that enter the ladder (rung 0). */
const ladderSource = defineWaypoint(defineSource<LadderChapter>('jsonl://./jsonl/ladder.jsonl'), {
  onItem: () => {
    ladderCounts.records += 1
  },
})

/** Count what a target stores and log the count when the stage closes. */
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

/** JSONL record → the shape `chapterDocBuild` accepts. */
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

/** Markdown document → token-bounded Chunk entities (the paragraphs stay whole). */
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

/** Chunk → Paragraph entities (blank-line separated parts of the chunk). */
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

/** Paragraph → Line entities. */
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

/** Line → Word entities (`tokenizeWords` is the package word splitter). */
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

/** Render the summary: one row per rung with the number of units it produced. */
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

/** Rung 0 → 1: a JSONL record becomes a markdown document. */
const documentStage = definePipeline({ id: 'sample2-ladder-documents' })
  .from(ladderSource)
  .flatMap(async (record: unknown) => [toChapterInput(record as LadderChapter)])
  .use(chapterDocBuild)
  .use(chapterIndexer)
  .use(chapterDocEmit)
  .to(countingTarget<string>('md://./chapters/ladder-chapters', 'documents'))

/** Rung 1 → 2: the markdown document becomes token-bounded Chunk entities. */
const chunkStage = definePipeline({ id: 'sample2-ladder-chunks' })
  .from('md://./chapters/ladder-chapters')
  .flatMap(async (item: unknown) => toChunks(readChapterDoc(String(item))))
  .to(countingTarget<ChunkEntity>('chunks://ladder', 'chunks'))

/** Rung 2 → 3: a chunk becomes Paragraph entities (each carries its `chunkId`). */
const paragraphStage = definePipeline({ id: 'sample2-ladder-paragraphs' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toParagraphs(chunk as ChunkEntity))
  .to(countingTarget<ParagraphEntity>('paragraphs://ladder', 'paragraphs'))

/** Rung 3 → 4: a paragraph becomes Line entities. */
const lineStage = definePipeline({ id: 'sample2-ladder-lines' })
  .from('paragraphs://ladder')
  .flatMap(async (paragraph: unknown) => toLines(paragraph as ParagraphEntity))
  .to(countingTarget<LineEntity>('lines://ladder', 'lines'))

/** Rung 4 → 5: a line becomes Word entities. */
const wordStage = definePipeline({ id: 'sample2-ladder-words' })
  .from('lines://ladder')
  .flatMap(async (line: unknown) => toWords(line as LineEntity))
  .to(countingTarget<WordEntity>('words://ladder', 'words'))

/** The last rung writes the summary: how many units every rung produced. */
const summaryStage = definePipeline({ id: 'sample2-ladder-summary' })
  .from('words://ladder')
  .batch(10_000)
  .flatMap(async (words: unknown) => [renderLadderSummary((words as WordEntity[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

/**
 * The Structure Ladder, one `.subflow()` per rung.
 *
 * The stages run in declaration order, so every rung finds the envelopes of the
 * rung above it in the entity buffer it reads.
 */
export const ladderPipeline = definePipeline({ id: 'sample2-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(paragraphStage)
  .subflow(lineStage)
  .subflow(wordStage)
  .subflow(summaryStage)

// ---------------------------------------------------------------------------
// The alternate route: chunks -> tokens
//
// The ladder is a tree. `chunks://` has two children: the descent into text
// units (`paragraphs://` -> `lines://` -> `words://`) and the descent into what
// the LLM actually sees (`tokens://`, tiktoken-style BPE tokens).
//
//   jsonl -> md -> chunks -+-> paragraphs -> lines -> words   (ladderPipeline)
//                          `-> tokens                         (tokenLadderPipeline)
// ---------------------------------------------------------------------------

/** True when any chunk fell back to heuristic pieces (gpt-tokenizer unavailable). */
let tokenHeuristic = false

/** Chunk -> Token entities (BPE ids with their decoded pieces). */
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

/** Render the token-ladder summary: chunk and token counts plus the heuristic flag. */
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

/** Chunk -> Token: every chunk becomes its BPE tokens. */
const tokenStage = definePipeline({ id: 'sample2-ladder-tokens' })
  .from('chunks://ladder')
  .flatMap(async (chunk: unknown) => toTokens(chunk as ChunkEntity))
  .to(countingTarget<TokenEntity>('tokens://ladder', 'tokens'))

/** The last rung writes the summary: chunk and token counts. */
const tokenSummaryStage = definePipeline({ id: 'sample2-ladder-token-summary' })
  .from('tokens://ladder')
  .batch(100_000)
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as TokenEntity[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

/**
 * The alternate route of the ladder: jsonl -> md -> chunks:// -> tokens:// -> summary.
 *
 * Shares the document and chunk rungs with `ladderPipeline`; only the descent
 * below `chunks://` differs.
 */
export const tokenLadderPipeline = definePipeline({ id: 'sample2-token-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(tokenStage)
  .subflow(tokenSummaryStage)
// ---------------------------------------------------------------------------
// Series split — split a chapter into equal parts with series frontmatter.
// ---------------------------------------------------------------------------
export const seriesSplitPipeline = definePipeline({ id: 'sample2-series-split' })
  .from('md://./chapters/chapter1.md')
  .use(seriesSplitTool)
  .to('md://./chapters/series-output.md')
