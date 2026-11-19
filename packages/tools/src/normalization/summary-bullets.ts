import { chapterBodyOf } from './chapter-stats.js'
import { splitSentences } from './heuristic-summary.js'

/** R6: a summary longer than this share of its chapter is a silent whole-chapter copy. */
const SUMMARY_MAX_BODY_RATIO = 0.25

function wordsOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Normalises an LLM answer into dash-bulleted lines: a bullet block is kept as-is, a paragraph
 * becomes one bullet per sentence, and a single sentence stays a single bullet.
 */
export function summaryBullets(summary: string): string[] {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return []
  if (lines.every((line) => /^-\s+\S/.test(line))) return lines

  const prose = lines.map((line) => line.replace(/^-\s+/, '')).join(' ')
  const sentences = splitSentences(prose)
  const values = sentences.length > 0 ? sentences : [prose]
  return values.map((sentence) => `- ${sentence.replace(/\s+/g, ' ').trim()}`)
}

/**
 * R6 guard for the emitted summary: fails the run (naming the chapter) when the summary is
 * empty or longer than 25 % of the chapter body - the silent whole-chapter copy the summary
 * tool falls back to when the LLM answer is rejected.
 */
export function assertSummaryIsShort(
  number: number,
  title: string,
  summary: string,
  markdown: string,
  llmFailure?: string,
): string[] {
  const suffix = llmFailure ? ` (LLM: ${llmFailure})` : ''
  const bullets = summaryBullets(summary)
  if (bullets.length === 0) {
    throw new Error(`summary R6: chapter ${number} ("${title}") has an empty summary${suffix}`)
  }
  const summaryWords = wordsOf(bullets.map((line) => line.replace(/^-\s+/, '')).join(' '))
  const bodyWords = wordsOf(chapterBodyOf(markdown))
  if (summaryWords > bodyWords * SUMMARY_MAX_BODY_RATIO) {
    throw new Error(
      `summary R6: chapter ${number} ("${title}") summary is ${summaryWords} words, over 25 % of the ${bodyWords}-word chapter body${suffix}`,
    )
  }
  return bullets
}
