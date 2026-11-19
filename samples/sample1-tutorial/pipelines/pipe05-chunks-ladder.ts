import {
  annotate,
  definePipeline,
  defineProcess,
  getVariable,
  log,
  parseChapterTree,
  useCase,
} from '@mt/core'
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
 * PIPE 05 — the structure ladder: chunking and the typed rung buffers.
 *
 * A markdown chapter can be viewed at several levels:
 *
 *   records → documents → chunks → paragraphs → lines → words
 *                      └──────────────→ tokens
 *
 * `chunks://`, `paragraphs://`, `lines://`, `words://` and `tokens://` are typed rung
 * buffers. A split-form subflow fills them through an explicit target: the parent stage
 * splits via `.subflow('<scheme>://', stagePipe)` and `stagePipe` writes each child with
 * `.to('<scheme>://ladder')`; the next stage reads the buffer back
 * (`.from('<scheme>://ladder')`). The parent stream passes through unchanged — the split
 * is a synchronous side branch.
 *
 * The other lessons in this file:
 *   - `chunkSplit` cleans decorative `---` lines and writes token-bounded chunks.
 *   - A second split of the written file reuses the same separators (round trip).
 *   - `parseChapterTree` mutates one line inside one chunk.
 *   - The `series` splitter partitions a long chapter deterministically.
 */
const seriesSplitFirstStage = definePipeline({ id: 'pipe05-series-first' })
  .from('md://./fixtures/chapter-series.md')
  .subflow(
    'series://',
    definePipeline({ id: 'pipe05-series-parts' }).to('md://./chapters/series-first-output.md'),
  )

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
    // The body is markdown: one paragraph per record paragraph, so the ladder's
    // paragraph/line rungs keep the record structure.
    return [{ title, number, body: paragraphs.map((lines) => lines.join('\n')).join('\n\n') }]
  })
  .use(chapterDocBuild)
  .use(chapterIndexer)
  .use(chapterDocEmit)
  .tap(countRung('documents'))
  .to('md://./chapters/ladder-chapters')

// Rung pipes: the split-form subflow children. No `.from()` (they receive the split
// envelopes from the parent stage); each counts its rung and publishes into its buffer.
const chunkPipe = definePipeline({ id: 'pipe05-chunks' })
  .tap(countRung('chunks'))
  .to('chunks://ladder')

const paragraphPipe = definePipeline({ id: 'pipe05-paragraphs' })
  .tap(countRung('paragraphs'))
  .to('paragraphs://ladder')

const linePipe = definePipeline({ id: 'pipe05-lines' }).tap(countRung('lines')).to('lines://ladder')

const wordPipe = definePipeline({ id: 'pipe05-words' }).tap(countRung('words')).to('words://ladder')

const tokenPipe = definePipeline({ id: 'pipe05-tokens' })
  .tap(countRung('tokens'))
  .to('tokens://ladder')

// Rung stages: read the previous rung, split through the subflow, drain the parent
// stream (no target — the runner drains what the side branch leaves behind).
const chunksStage = definePipeline({ id: 'pipe05-chunks-stage' })
  .from('md://./chapters/ladder-chapters')
  .subflow('chunks://', chunkPipe)

const paragraphsStage = definePipeline({ id: 'pipe05-paragraphs-stage' })
  .from('chunks://ladder')
  .subflow('paragraphs://', paragraphPipe)

const linesStage = definePipeline({ id: 'pipe05-lines-stage' })
  .from('paragraphs://ladder')
  .subflow('lines://', linePipe)

const wordsStage = definePipeline({ id: 'pipe05-words-stage' })
  .from('lines://ladder')
  .subflow('words://', wordPipe)

const tokensStage = definePipeline({ id: 'pipe05-tokens-stage' })
  .from('chunks://ladder')
  .subflow('tokens://', tokenPipe)

// One batch child per summary: the package (10k words) is one input envelope, `flatMap` turns
// it into the single rendered summary, and the child owns the target (a sink — the words drain).
const summaryChild = definePipeline({ id: 'pipe05-summary-child' })
  .tap(async () => logLadderCounts())
  .flatMap(async (words: unknown) => [renderLadderSummary((words as unknown[]).length)])
  .use(mdOutputEmitter({ name: 'ladder-summary', filename: () => 'ladder-summary.md' }))
  .to('md://./chapters')

const summaryStage = definePipeline({ id: 'pipe05-summary' })
  .from('words://ladder')
  .subflow('batch://?size=10000', summaryChild)

export const ladderPipeline = definePipeline({ id: 'pipe05-ladder' })
  .subflow(documentStage)
  .subflow(chunksStage)
  .subflow(paragraphsStage)
  .subflow(linesStage)
  .subflow(wordsStage)
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

const tokenSummaryChild = definePipeline({ id: 'pipe05-token-summary-child' })
  .tap(async () => logLadderCounts())
  .flatMap(async (tokens: unknown) => [renderTokenSummary((tokens as unknown[]).length)])
  .use(mdOutputEmitter({ name: 'token-ladder-summary', filename: () => 'token-ladder-summary.md' }))
  .to('md://./chapters')

const tokenSummaryStage = definePipeline({ id: 'pipe05-token-summary' })
  .from('tokens://ladder')
  .subflow('batch://?size=100000', tokenSummaryChild)

export const tokenLadderPipeline = definePipeline({ id: 'pipe05-token-ladder' })
  .subflow(documentStage)
  .subflow(chunksStage)
  .subflow(tokensStage)
  .subflow(tokenSummaryStage)

export default annotate(
  defineProcess()
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
    ),
  useCase('UC056', { name: 'Split large chapters by token count' }),
)
