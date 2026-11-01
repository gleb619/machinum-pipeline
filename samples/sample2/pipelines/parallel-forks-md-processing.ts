import { type Chapter, type Paragraph, definePipeline } from '@mt/core'
import { readChapterDoc, tokenizeWords } from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// One chapter, three views, one markdown file.
//
// The parent pipeline turns every JSONL record into a core `Chapter`, then
// hands that chapter to three branch pipelines with:
//
//     .fork('chapter-views', [countBranch, reorderBranch, commasBranch])
//
// That single call is the whole concurrency demo:
//
//   - each branch gets an isolated, deep-cloned copy of the chapter envelope;
//   - the branches run concurrently for every parent envelope;
//   - each parent/branch gets its own checkpoint node
//     (`<stepId>/fork-<parent>/branch-<branch>`);
//   - branch output is buffered and merged in declaration order, so the file
//     is deterministic even when branches finish at different times;
//   - a failed branch fails the run after every branch has settled.
// ---------------------------------------------------------------------------

interface ChapterInput {
  number: number
  markdown: string
}

/** Parse one JSONL record into the core `Chapter` entity used by the branches. */
function toChapter(input: ChapterInput): Chapter {
  const doc = readChapterDoc(input.markdown)
  const id = `chapter-${input.number}`

  return {
    id,
    bookId: 'sample2',
    title: doc.title,
    body: doc.body.map((paragraph) => paragraph.lines.join('\n')).join('\n\n'),
    index: input.number - 1,
  }
}

/** Split chapter body on blank lines and stamp stable paragraph ids. */
function paragraphsOf(chapter: Chapter): Paragraph[] {
  return chapter.body
    .split(/\n\s*\n/)
    .map((body) => body.trim())
    .filter((body) => body.length > 0)
    .map((body, index) => ({
      id: `${chapter.id}/paragraph-${index + 1}`,
      chapterId: chapter.id,
      body,
      index,
    }))
}

/** Display lines of one paragraph. */
function linesOf(paragraph: Paragraph): string[] {
  return paragraph.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

interface ChapterCounts {
  paragraphs: number
  lines: number
  words: number
}

function countChapter(chapter: Chapter): ChapterCounts {
  const paragraphs = paragraphsOf(chapter)

  return {
    paragraphs: paragraphs.length,
    lines: paragraphs.reduce((total, paragraph) => total + linesOf(paragraph).length, 0),
    words: tokenizeWords(chapter.body).length,
  }
}

/** Render one markdown section; the trailing newline separates target writes. */
function renderSection(heading: string, lines: string[]): string {
  return [`## ${heading}`, '', ...lines, ''].join('\n')
}

function renderCounts(chapter: Chapter): string {
  const counts = countChapter(chapter)
  const summary = `${counts.paragraphs} paragraphs · ${counts.lines} lines · ${counts.words} words`

  return [`# ${chapter.title}`, '', renderSection('counts', [summary])].join('\n')
}

function renderReorderedLines(chapter: Chapter): string {
  const blocks = paragraphsOf(chapter).flatMap((paragraph, index) => {
    const ordered = [...linesOf(paragraph)].sort((left, right) => left.localeCompare(right))

    return [
      ...(index > 0 ? [''] : []),
      `### paragraph ${index + 1}`,
      '',
      ...ordered.map((line) => `- ${line}`),
    ]
  })

  return renderSection('lines reordered', blocks)
}

function renderCommas(chapter: Chapter): string {
  const paragraphs = paragraphsOf(chapter).map((paragraph) => paragraph.body.replaceAll('.', ','))

  return renderSection('dots replaced with commas', [paragraphs.join('\n\n')])
}

// Steps-only pipelines: each branch consumes the parent envelope. The runner
// supplies the isolated chapter copy and the checkpoint node.
const countBranch = definePipeline<Chapter>({ id: 'chapter-counts' }).flatMap(async (chapter) => [
  renderCounts(chapter),
])

const reorderBranch = definePipeline<Chapter>({ id: 'chapter-line-order' }).flatMap(
  async (chapter) => [renderReorderedLines(chapter)],
)

const commasBranch = definePipeline<Chapter>({ id: 'chapter-commas' }).flatMap(async (chapter) => [
  renderCommas(chapter),
])

const parallelForksPipeline = definePipeline({ id: 'sample2-parallel-forks' })
  .from('jsonl://./jsonl/entities.jsonl')
  .flatMap(async (record: unknown) => [toChapter(record as ChapterInput)])
  .fork('chapter-views', [countBranch, reorderBranch, commasBranch])
  .to('md://./chapters/parallel-forks.md')

export default parallelForksPipeline
