import {
  type Chapter,
  type Line,
  type Paragraph,
  definePipeline,
  defineTarget,
  defineTool,
  defineWaypoint,
  withItem,
} from '@mt/core'
import {
  type ChapterDoc,
  type ChapterDocParagraph,
  chapterDocBuild,
  chapterDocEmit,
  chapterIndexer,
  readChapterDoc,
  tokenizeWords,
} from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// Entities
//
// The core domain types are Book -> Chapter -> Paragraph -> Line. There is no
// `Word` entity in `@mt/core`, so this sample declares one; everything else is
// the real type. Identity lives on the entity (`id` + parent id) and is carried
// inside the exchange payload, while the engine carries provenance in `meta`.
// ---------------------------------------------------------------------------

interface ChapterRecord {
  number: number
  title: string
  paragraphs: string[][]
}

interface ChapterInput extends Pick<Chapter, 'title'> {
  number: number
  body: ChapterDocParagraph[]
}

interface ParagraphEntity extends Paragraph {
  lines: string[]
}

interface LineEntity extends Line {
  chapterId: string
}

export interface WordEntity {
  id: string
  chapterId: string
  paragraphId: string
  lineId: string
  word: string
  index: number
}

const CHAPTERS_DIR = 'md://./chapters-out'

// ---------------------------------------------------------------------------
// Small glue: reuse the package parser instead of re-implementing md splitting
// ---------------------------------------------------------------------------

const parseChapterDoc = defineTool<string, ChapterDoc>({
  name: 'sample3-parse-chapter-doc',
  version: '1.0.0',
  mdDescription:
    'Parse markdown into ChapterDoc (paragraphs + lines) via @mt/tools readChapterDoc.',
  invoke: async (env, _ctx) => withItem(env, readChapterDoc(env.item)),
})

// JSONL record -> the shape chapterDocBuild accepts.
function toChapterInput(record: ChapterRecord): ChapterInput {
  return {
    number: record.number,
    title: record.title,
    body: record.paragraphs.map((lines) => ({ lines })),
  }
}

// ChapterDoc -> Paragraph entities (one envelope per paragraph).
function toParagraphs(doc: ChapterDoc): ParagraphEntity[] {
  const chapterId = `chapter-${doc.number ?? 0}`
  return doc.body.map((paragraph, index) => ({
    id: `${chapterId}/paragraph-${index + 1}`,
    chapterId,
    index,
    lines: paragraph.lines,
    body: paragraph.lines.join(' '),
  }))
}

// Paragraph entity -> Line entities (one envelope per source line).
function toLines(paragraph: ParagraphEntity): LineEntity[] {
  return paragraph.lines.map((text, index) => ({
    id: `${paragraph.id}/line-${index + 1}`,
    paragraphId: paragraph.id,
    chapterId: paragraph.chapterId,
    index,
    text,
  }))
}

// Line entity -> Word entities. `tokenizeWords` is the package word splitter.
function toWords(line: LineEntity): WordEntity[] {
  return tokenizeWords(line.text).map((word, index) => ({
    id: `${line.id}/word-${index + 1}`,
    chapterId: line.chapterId,
    paragraphId: line.paragraphId,
    lineId: line.id,
    index,
    word,
  }))
}

// ---------------------------------------------------------------------------
// Waypoints: log entity counts without touching the payload
// ---------------------------------------------------------------------------

function entitySink<T>(uri: string, label: string) {
  let count = 0
  return defineWaypoint(defineTarget<T>(uri), {
    onOpen: () => {
      count = 0
    },
    onWrite: () => {
      count += 1
    },
    onClose: () => console.log(`[entities] ${label}=${count}`),
  })
}

// ---------------------------------------------------------------------------
// Stage 1: JSONL -> markdown (one file per chapter)
//
// chapterDocBuild + chapterIndexer + chapterDocEmit are the real package tools:
// build serializes frontmatter/heading, indexer stamps `meta.chapterNum`, emit
// appends the `mdOutputs` intent that the md:// directory target writes.
// ---------------------------------------------------------------------------

const chapterMdPipeline = definePipeline({ id: 'sample3-entity-chapter-md' })
  .from('jsonl://./jsonl/entities.jsonl')
  .flatMap(async (record: unknown) => [toChapterInput(record as ChapterRecord)])
  .use(chapterDocBuild)
  .use(chapterIndexer)
  .use(chapterDocEmit)
  .tap(async (env) => {
    console.log(JSON.stringify({ stage: 'chapter', chapterNum: env.meta.chapterNum }))
  })
  .to(CHAPTERS_DIR)

// ---------------------------------------------------------------------------
// Stage 2: markdown -> Paragraph entities, buffered in ephemeral://
// ---------------------------------------------------------------------------

const paragraphPipeline = definePipeline({ id: 'sample3-entity-paragraphs' })
  .from(CHAPTERS_DIR)
  .use(parseChapterDoc)
  .flatMap(async (doc: unknown) => toParagraphs(doc as ChapterDoc))
  .to(entitySink<ParagraphEntity>('ephemeral://sample3-paragraphs', 'paragraphs'))

// ---------------------------------------------------------------------------
// Stage 3: Paragraph -> Line entities (ephemeral handoff, same process)
// ---------------------------------------------------------------------------

const linePipeline = definePipeline({ id: 'sample3-entity-lines' })
  .from('ephemeral://sample3-paragraphs')
  .flatMap(async (paragraph: unknown) => toLines(paragraph as ParagraphEntity))
  .to(entitySink<LineEntity>('ephemeral://sample3-lines', 'lines'))

// ---------------------------------------------------------------------------
// Stage 4: Line -> Word entities, then one JSONL line per word
//
// `.batch` collapses the stream for a single summary log; the following
// `.flatMap` fans the batch back out so jsonl:// gets one word per envelope.
// ---------------------------------------------------------------------------

const wordPipeline = definePipeline({ id: 'sample3-entity-words' })
  .from('ephemeral://sample3-lines')
  .flatMap(async (line: unknown) => toWords(line as LineEntity))
  .batch(10_000)
  .tap(async (env) => {
    console.log(`[entities] words=${env.items?.length ?? 1}`)
  })
  .flatMap(async (words: unknown) => words as WordEntity[])
  .to('jsonl://./entities/words.jsonl')

// ---------------------------------------------------------------------------
// Default: orchestrate the four self-contained stages.
//
// Each `.subflow()` has its own `.from()`, so it drains the parent (empty) and
// runs independently. ephemeral:// is a module-level buffer: stage boundaries
// 2 -> 3 -> 4 stay in memory because they run inside this one process.
// ---------------------------------------------------------------------------

export default definePipeline({ id: 'sample3-entity-md-processing' })
  .subflow(chapterMdPipeline)
  .subflow(paragraphPipeline)
  .subflow(linePipeline)
  .subflow(wordPipeline)

// ---------------------------------------------------------------------------
// Branching demo: sync fork, async fork, then a genuinely concurrent tool step
//
// `.fork()` is per-envelope nesting, NOT parallelism: the two child pipelines
// run one after another for each envelope. Real parallelism comes from the
// engine's per-tool-step concurrency (`defaults.concurrency` in mt.json); the
// probe logs start/end timestamps so overlapping windows are visible.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const tagSync = defineTool<ParagraphEntity, ParagraphEntity>({
  name: 'sample3-tag-sync',
  version: '1.0.0',
  mdDescription: 'Synchronous fork: append a marker to the paragraph body.',
  invoke: async (env, _ctx) => {
    console.log(`[branch] sync=${env.item.id}`)
    return withItem(env, { ...env.item, body: `${env.item.body} [sync]` })
  },
})

const tagAsync = defineTool<ParagraphEntity, ParagraphEntity>({
  name: 'sample3-tag-async',
  version: '1.0.0',
  mdDescription: 'Asynchronous fork: await a tick, then append a marker.',
  invoke: async (env, _ctx) => {
    await sleep(1)
    console.log(`[branch] async=${env.item.id}`)
    return withItem(env, { ...env.item, body: `${env.item.body} [async]` })
  },
})

const concurrencyProbe = defineTool<ParagraphEntity, ParagraphEntity>({
  name: 'sample3-concurrency-probe',
  version: '1.0.0',
  mdDescription: 'Record start/end timestamps so overlapping executions are visible.',
  invoke: async (env, _ctx) => {
    const start = Date.now()
    await sleep(25)
    console.log(JSON.stringify({ probe: 'parallel', id: env.item.id, start, end: Date.now() }))
    return env
  },
})

const syncBranch = definePipeline({ id: 'sample3-branch-sync' }).use(tagSync)
const asyncBranch = definePipeline({ id: 'sample3-branch-async' }).use(tagAsync)

export const parallelBranchesPipeline = definePipeline({ id: 'sample3-entity-branches' })
  .from('jsonl://./jsonl/entities.jsonl')
  .flatMap(async (record: unknown) => [toChapterInput(record as ChapterRecord)])
  .use(chapterDocBuild)
  .use(parseChapterDoc)
  .flatMap(async (doc: unknown) => toParagraphs(doc as ChapterDoc))
  .fork(syncBranch)
  .fork(asyncBranch)
  .use(concurrencyProbe)
  .to(entitySink<ParagraphEntity>('ephemeral://sample3-branch-output', 'branch-output'))
