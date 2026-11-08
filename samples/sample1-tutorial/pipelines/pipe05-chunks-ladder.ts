import { definePipeline, defineProcess, getVariable, log, parseChapterTree } from '@mt/core'
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

/**
 * PIPE 05 — the structure ladder: chunking and the typed rung sources.
 *
 * A markdown chapter can be viewed at several levels:
 *
 *   records → documents → chunks → paragraphs → lines → words
 *                      └──────────────→ tokens
 *
 * `chunks://`, `paragraphs://`, `lines://`, `words://` and `tokens://` are read-only rung
 * sources: a string-form subflow publishes its output into a named buffer
 * (`.subflow('chunks://', 'ladder')`) and the next stage reads it back (`chunks://ladder`).
 *
 * The other lessons in this file:
 *   - `chunkSplit` cleans decorative `---` lines and writes token-bounded chunks.
 *   - A second split of the written file reuses the same separators (round trip).
 *   - `parseChapterTree` mutates one line inside one chunk.
 *   - The `series` splitter partitions a long chapter deterministically.
 */
const seriesSplitFirstStage = definePipeline({ id: 'pipe05-series-first' })
  .from('md://./fixtures/chapter-series.md')
  .subflow('series://')
  .to('md://./chapters/series-first-output.md')

const cleanSplitStage = definePipeline({ id: 'pipe05-clean-split' })
  .from('md://./fixtures/chapter1.md')
  .use(chunkSplit)
  .tap(async (env) => {
    log.info('clean-split', {
      stage: 'clean-split',
      chunkCount: getVariable<number>(env, VAR_CHUNK_COUNT),
      separator: getVariable<string>(env, VAR_CHUNK_SEPARATOR),
    })
  })
  .to('md://./chapters/chunked.md')

const reuseStage = definePipeline({ id: 'pipe05-chunk-reuse' })
  .from('md://./chapters/chunked.md')
  .use(chunkSplit)
  .tap(async (env) => {
    log.info('reuse', {
      stage: 'reuse',
      chunkCount: getVariable<number>(env, VAR_CHUNK_COUNT),
      reused: true,
    })
  })
  .to('md://./chapters/chunked-reused.md')

export const treeMutationPipeline = definePipeline({ id: 'pipe05-tree-mutation' })
  .from('md://./fixtures/chapter1.md')
  .flatMap(async (markdown: unknown) => {
    const tree = parseChapterTree(String(markdown), {
      id: 'chapter1-tree',
      meta: { bookId: 'sample1-tutorial' },
    })
    const firstLine = tree.chunks()[0]?.paragraphs()[0]?.lines[0]
    if (firstLine) firstLine.text = `${firstLine.text} [tree-edit]`
    return [tree.toMarkdown()]
  })
  .to('md://./chapters/tree-mutated.md')

export const cleanSplitPipeline = definePipeline({ id: 'pipe05-clean-split-suite' })
  .subflow(seriesSplitFirstStage)
  .subflow(cleanSplitStage)
  .subflow(reuseStage)

interface LadderRecord {
  number: number
  title: string
  paragraphs: string[][]
}

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
    log.info(`[ladder] ${rung}=${count}`)
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

const documentStage = definePipeline({ id: 'pipe05-documents' })
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

const chunkStage = definePipeline({ id: 'pipe05-chunks' })
  .from('md://./chapters/ladder-chapters')
  .subflow('chunks://', 'ladder')
  .tap(countRung('chunks'))

const paragraphStage = definePipeline({ id: 'pipe05-paragraphs' })
  .from('chunks://ladder')
  .subflow('paragraphs://', 'ladder')
  .tap(countRung('paragraphs'))

const lineStage = definePipeline({ id: 'pipe05-lines' })
  .from('paragraphs://ladder')
  .subflow('lines://', 'ladder')
  .tap(countRung('lines'))

const wordStage = definePipeline({ id: 'pipe05-words' })
  .from('lines://ladder')
  .subflow('words://', 'ladder')
  .tap(countRung('words'))

const summaryStage = definePipeline({ id: 'pipe05-summary' })
  .from('words://ladder')
  .batch(10_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (words: unknown) => [renderLadderSummary((words as unknown[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

export const ladderPipeline = definePipeline({ id: 'pipe05-ladder' })
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

const tokenStage = definePipeline({ id: 'pipe05-tokens' })
  .from('chunks://ladder')
  .subflow('tokens://', 'ladder')
  .tap(countRung('tokens'))

const tokenSummaryStage = definePipeline({ id: 'pipe05-token-summary' })
  .from('tokens://ladder')
  .batch(100_000)
  .tap(async () => logLadderCounts())
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as unknown[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

export const tokenLadderPipeline = definePipeline({ id: 'pipe05-token-ladder' })
  .subflow(documentStage)
  .subflow(chunkStage)
  .subflow(tokenStage)
  .subflow(tokenSummaryStage)

export default defineProcess()
  .config({
    env: {
      MT_CHUNK_SIZE: '40',
      MT_CONST_SERIES_SPLIT_TARGET_CHARS: '150',
    },
  })
  .pipeline(
    definePipeline({ id: 'pipe05-suite' })
      .subflow(cleanSplitPipeline)
      .subflow(ladderPipeline)
      .subflow(tokenLadderPipeline)
      .subflow(treeMutationPipeline),
  )
