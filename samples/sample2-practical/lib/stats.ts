import { type Exchange, batchMembersOf, defineTool, getVariable, setVariable } from '@mt/core'
import { appendMdOutput } from '@mt/tools'

/**
 * Chapter body = the markdown with the leading `# ` H1 line removed (the heading line and the
 * newline that ends it). `bodyChars` is the character length of that remainder. The test imports
 * {@link bodyCharsOf} so both sides use this one definition.
 */
export function chapterBody(markdown: string): string {
  return markdown.replace(/^#[ \t]+[^\r\n]*(?:\r?\n|$)/, '')
}

/** Character length of {@link chapterBody}. */
export function bodyCharsOf(markdown: string): number {
  return chapterBody(markdown).length
}

/** Variable carrying one chapter's measured row between the two glue stages. */
export const VAR_CHAPTER_STATS = 'chapterStats'

/** Per-chapter measurement before the book-level ratios are known. */
export interface ChapterMeasure {
  n: number
  id: string
  words: number
  bodyChars: number
  tokens: number
}

export interface ChapterStats extends ChapterMeasure {
  ratioToMean: number
  oversize: boolean
}

export interface BookStats {
  chapters: number
  totalWords: number
  totalTokens: number
  mean: number
  median: number
  threshold: number
}

/** The `chapters/schema/stats.json` shape (stable key order, no timestamps). */
export interface StatsArtifact {
  version: number
  unit: 'bodyChars'
  factor: number
  book: BookStats
  chapters: ChapterStats[]
  oversize: number[]
}

const VERSION = 1
const FACTOR = 1.5

/** Round to four decimals so a rerun serializes byte-identically. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Aggregate the measured chapters into the deterministic stats artefact. */
export function buildStats(measures: readonly ChapterMeasure[]): StatsArtifact {
  const ordered = [...measures].sort((left, right) => left.n - right.n)
  const bodyChars = ordered.map((measure) => measure.bodyChars)
  const chapters = ordered.length
  const mean = chapters > 0 ? round4(bodyChars.reduce((sum, n) => sum + n, 0) / chapters) : 0
  const threshold = round4(mean * FACTOR)

  const rows: ChapterStats[] = ordered.map((measure) => ({
    n: measure.n,
    id: measure.id,
    words: measure.words,
    bodyChars: measure.bodyChars,
    tokens: measure.tokens,
    ratioToMean: mean > 0 ? round4(measure.bodyChars / mean) : 0,
    oversize: measure.bodyChars > threshold,
  }))

  return {
    version: VERSION,
    unit: 'bodyChars',
    factor: FACTOR,
    book: {
      chapters,
      totalWords: ordered.reduce((sum, measure) => sum + measure.words, 0),
      totalTokens: ordered.reduce((sum, measure) => sum + measure.tokens, 0),
      mean,
      median: round4(median(bodyChars)),
      threshold,
    },
    chapters: rows,
    oversize: rows.filter((row) => row.oversize).map((row) => row.n),
  }
}

/**
 * Stage A (runs on `batch://members`): turns the `chapterNum`, `wordCount` and `tokenCount`
 * written by the shipped tools into this chapter's row.
 */
export const collectChapterStats = defineTool<string, string>({
  name: 'collect-chapter-stats',
  version: '1.0.0',
  description:
    'Stores the chapter number, words, body characters and tokens of one batch member as `chapterStats`.',
  async invoke(env) {
    const n = Number(env.meta.chapterNum ?? 0)
    const measure: ChapterMeasure = {
      n,
      id: String(n),
      words: getVariable<number>(env, 'wordCount') ?? env.item.split(/\s+/).filter(Boolean).length,
      bodyChars: bodyCharsOf(env.item),
      tokens: getVariable<number>(env, 'tokenCount') ?? 0,
    }
    return setVariable(env, VAR_CHAPTER_STATS, measure)
  },
})

/**
 * Aggregation stage (runs on `batch://group`): turns every member's `chapterStats` into one
 * deterministic `stats.json` md output intent (no timestamps, chapters sorted by `n`).
 */
export const writeStats = defineTool<unknown, unknown>({
  name: 'write-stats',
  version: '1.0.0',
  description:
    'Emits schema/stats.json from the `chapterStats` rows of every member of the batch package.',
  async invoke(env) {
    const members = batchMembersOf<unknown>(env) ?? []
    const measures = members
      .map((member: Exchange<unknown>) => getVariable<ChapterMeasure>(member, VAR_CHAPTER_STATS))
      .filter((measure): measure is ChapterMeasure => measure !== undefined)
    const artifact = buildStats(measures)
    return appendMdOutput(env, {
      name: 'stats',
      subdir: '',
      filename: 'stats.json',
      content: `${JSON.stringify(artifact, null, 2)}\n`,
    })
  },
})
