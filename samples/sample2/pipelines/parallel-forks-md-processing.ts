import { type Line, type Paragraph, definePipeline } from '@mt/core'
import { tokenizeWords } from '@mt/tools'
import '@mt/waypoint'

// ---------------------------------------------------------------------------
// Parallel forks over the main entities
//
// One JSONL record is one chapter:
//
//   Chapter -> Paragraph -> Line
//
// Every chapter is split into its paragraphs and lines, then three async
// branches run at the same time:
//
//   - count-paragraphs: count paragraphs, lines and words
//   - reorder-lines:    sort the lines of every paragraph
//   - dots-to-commas:   replace every '.' with ','
//
// Core `.fork()` starts a nested Runner per envelope and runs the branches
// sequentially for that envelope. This sample needs true parallel branches, so
// it forks the work explicitly with `Promise.all` inside one async step.
// Each branch logs its own start/end timestamp; the run output proves overlap.
// ---------------------------------------------------------------------------

interface ChapterRecord {
  number: number
  title: string
  paragraphs: string[][]
}

interface LineEntity extends Line {
  index: number
}

interface ParagraphEntity extends Paragraph {
  index: number
  lines: LineEntity[]
}

interface ChapterEntity {
  id: string
  number: number
  title: string
  paragraphs: ParagraphEntity[]
}

interface ChapterStats {
  paragraphs: number
  lines: number
  words: number
}

type ForkName = 'count-paragraphs' | 'reorder-lines' | 'dots-to-commas'
type ForkPhase = 'start' | 'done'

interface ForkResult<T> {
  name: ForkName
  startedAt: number
  finishedAt: number
  value: T
}

const FORK_DELAY_MS = 25

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function logFork(name: ForkName, phase: ForkPhase, chapterId: string, at: number): void {
  console.log(JSON.stringify({ stage: 'fork', name, phase, chapterId, at }))
}

/** Run one async branch and record its timing. */
async function runFork<T>(
  name: ForkName,
  chapterId: string,
  task: () => Promise<T> | T,
): Promise<ForkResult<T>> {
  const startedAt = Date.now()
  logFork(name, 'start', chapterId, startedAt)
  await sleep(FORK_DELAY_MS)
  const value = await task()
  const finishedAt = Date.now()
  logFork(name, 'done', chapterId, finishedAt)
  return { name, startedAt, finishedAt, value }
}

function toChapter(record: ChapterRecord): ChapterEntity {
  const chapterId = `chapter-${record.number}`
  return {
    id: chapterId,
    number: record.number,
    title: record.title,
    paragraphs: record.paragraphs.map((lines, paragraphIndex) => {
      const paragraphId = `${chapterId}/paragraph-${paragraphIndex + 1}`
      return {
        id: paragraphId,
        chapterId,
        body: lines.join(' '),
        index: paragraphIndex,
        lines: lines.map((text, lineIndex) => ({
          id: `${paragraphId}/line-${lineIndex + 1}`,
          paragraphId,
          text,
          index: lineIndex,
        })),
      }
    }),
  }
}

function countChapter(chapter: ChapterEntity): ChapterStats {
  const lines = chapter.paragraphs.flatMap((paragraph) => paragraph.lines)
  return {
    paragraphs: chapter.paragraphs.length,
    lines: lines.length,
    words: lines.reduce((total, line) => total + tokenizeWords(line.text).length, 0),
  }
}

/** Return the per-paragraph line indices in alphabetical line order. */
function reorderLines(chapter: ChapterEntity): number[][] {
  return chapter.paragraphs.map((paragraph) =>
    paragraph.lines
      .map((line, index) => ({ line, index }))
      .sort((left, right) => left.line.text.localeCompare(right.line.text))
      .map((entry) => entry.index),
  )
}

function replaceDots(chapter: ChapterEntity): ParagraphEntity[] {
  return chapter.paragraphs.map((paragraph) => ({
    ...paragraph,
    lines: paragraph.lines.map((line) => ({
      ...line,
      text: line.text.replaceAll('.', ','),
    })),
  }))
}

function mergeForks(
  chapter: ChapterEntity,
  lineOrder: number[][],
  dottedParagraphs: ParagraphEntity[],
): ChapterEntity {
  return {
    ...chapter,
    paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => {
      const dotted = dottedParagraphs[paragraphIndex] ?? paragraph
      const order = lineOrder[paragraphIndex] ?? paragraph.lines.map((_, index) => index)
      return {
        ...dotted,
        lines: order.flatMap((sourceIndex, newIndex) => {
          const line = dotted.lines[sourceIndex]
          return line ? [{ ...line, index: newIndex }] : []
        }),
      }
    }),
  }
}

function renderChapter(chapter: ChapterEntity, stats: ChapterStats): string {
  const lines = [
    `# ${chapter.title}`,
    '',
    `${stats.paragraphs} paragraphs · ${stats.lines} lines · ${stats.words} words`,
    '',
  ]
  for (const [paragraphIndex, paragraph] of chapter.paragraphs.entries()) {
    lines.push(`## Paragraph ${paragraphIndex + 1}`, '')
    for (const line of paragraph.lines) lines.push(`- ${line.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

const parallelForksPipeline = definePipeline({ id: 'sample2-parallel-forks' })
  .from('jsonl://./jsonl/entities.jsonl')
  .flatMap(async (record: unknown) => [toChapter(record as ChapterRecord)])
  .flatMap(async (chapter: unknown) => {
    const input = chapter as ChapterEntity
    const [countFork, reorderFork, dotsFork] = await Promise.all([
      runFork('count-paragraphs', input.id, () => countChapter(input)),
      runFork('reorder-lines', input.id, () => reorderLines(input)),
      runFork('dots-to-commas', input.id, () => replaceDots(input)),
    ])
    const merged = mergeForks(input, reorderFork.value, dotsFork.value)
    return [renderChapter(merged, countFork.value)]
  })
  .to('md://./chapters/parallel-forks.md')

export default parallelForksPipeline
