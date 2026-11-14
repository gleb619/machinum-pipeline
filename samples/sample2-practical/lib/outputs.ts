import { defineTool, getVariable, withItem } from '@mt/core'
import {
  type TitleTranslatorOutput,
  appendMdOutput,
  chapterNumberOf,
  loadGlossaryOrEmpty,
  splitSentences,
  tagTerms,
  titleOf,
} from '@mt/tools'
import { chapterBody } from './stats.js'

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
  const bodyWords = wordsOf(chapterBody(markdown))
  if (summaryWords > bodyWords * SUMMARY_MAX_BODY_RATIO) {
    throw new Error(
      `summary R6: chapter ${number} ("${title}") summary is ${summaryWords} words, over 25 % of the ${bodyWords}-word chapter body${suffix}`,
    )
  }
  return bullets
}

/**
 * Emits one `schema/chapter<N>.summary.md` per batched chapter.
 *
 * `createSummaryTool` publishes `summary` (first item) and `summaryByItem` (one per batched
 * input); this glue prefers the per-item values and keeps `summary` for a single chapter.
 */
export const writeSummaries = defineTool<unknown, string>({
  name: 'write-summaries',
  version: '1.1.0',
  mdDescription:
    'Emits schema/chapter<N>.summary.md from the `summaryByItem` variable (or `summary` for one chapter).',
  async invoke(env) {
    const chapters = (env.items ?? [env.item]).flat() as string[]
    const perItem = getVariable<string[]>(env, 'summaryByItem')
    const single = getVariable<string>(env, 'summary')
    const llmFailure = getVariable<{ lastFailure?: string }>(env, 'summaryLlm')?.lastFailure
    let out = withItem(env, '')
    chapters.forEach((markdown, index) => {
      const number = chapterNumberOf(markdown, index + 1)
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? `Chapter ${number}`
      const summary = perItem?.[index] ?? (chapters.length === 1 ? (single ?? '') : '')
      const bullets = assertSummaryIsShort(number, title, summary, markdown, llmFailure)
      out = appendMdOutput(out, {
        name: 'summary',
        subdir: 'schema',
        filename: `chapter${number}.summary.md`,
        content: `# ${title}\n\n## Summary\n\n${bullets.join('\n')}\n`,
      })
    })
    return out
  },
})

/** Emits the editable `glossary.json` built by `createGlossaryExtractor`. */
export const writeGlossary = defineTool<unknown, string>({
  name: 'write-glossary',
  version: '1.0.0',
  mdDescription: 'Emits glossary.json from the `glossaryJson` variable.',
  async invoke(env) {
    return appendMdOutput(withItem(env, ''), {
      name: 'glossary',
      subdir: '',
      filename: 'glossary.json',
      content: String(getVariable(env, 'glossaryJson') ?? '{"terms":[]}\n'),
    })
  },
})

/** Emits `titles.json` (`{ "<n>": { en, ru } }`) from a title-translator batch. */
export const writeTitles = defineTool<unknown, string>({
  name: 'write-titles',
  version: '1.0.0',
  mdDescription: 'Emits titles.json from the translated title batch and the `chapters` variable.',
  async invoke(env) {
    const chapters = getVariable<string[]>(env, 'chapters') ?? []
    const outputs = (env.items ?? (Array.isArray(env.item) ? env.item : [env.item])) as
      | TitleTranslatorOutput[]
      | TitleTranslatorOutput
    const list = Array.isArray(outputs) ? outputs : [outputs]
    const titles: Record<string, { en: string; ru: string }> = {}
    chapters.forEach((markdown, index) => {
      const number = chapterNumberOf(markdown, index + 1)
      titles[String(number)] = {
        en: titleOf(markdown),
        ru: list[index] ? titleOf(list[index].text) : '',
      }
    })
    return appendMdOutput(withItem(env, ''), {
      name: 'titles',
      subdir: '',
      filename: 'titles.json',
      content: `${JSON.stringify(titles, null, 2)}\n`,
    })
  },
})

/** Tags every batched chapter with the glossary terms (the translator reads the tags). */
export function tagWithGlossary(glossaryDir: string) {
  return defineTool<unknown, string | string[]>({
    name: 'tag-with-glossary',
    version: '1.0.0',
    mdDescription: 'Wraps glossary terms of every batched chapter in <term> tags.',
    async invoke(env) {
      const glossary = await loadGlossaryOrEmpty(glossaryDir)
      const tag = (markdown: string) => tagTerms(markdown, glossary)
      if (env.items) {
        const tagged = (env.items as unknown[]).flat().map((item) => tag(String(item)))
        return { ...withItem(env, tagged[0] as string), items: tagged }
      }
      return withItem(env, tag(String(env.item)))
    },
  })
}

/** Chapter number of an EN or RU heading (`# Chapter 10` / `# Глава 10`). */
function headingNumber(markdown: string): number {
  const match = /^#\s*(?:Chapter|Глава)\s*(\d+)/im.exec(markdown)
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER
}

/** Sorts chapter markdown by `# Chapter N` / `# Глава N` and collapses the batch into one item. */
export const sortChapters = defineTool<unknown, string[]>({
  name: 'sort-chapters',
  version: '1.0.0',
  mdDescription: 'Sorts batched chapter markdown by chapter number.',
  async invoke(env) {
    const chapters = (env.items ?? [env.item]).flat() as string[]
    const sorted = [...chapters].sort((left, right) => headingNumber(left) - headingNumber(right))
    return withItem(env, sorted)
  },
})

/** Wraps the sorted chapters in the bookCompiler options object (title + chapters). */
export function withBookTitle(title: string) {
  return defineTool<string[], { title: string; chapters: string[] }>({
    name: 'with-book-title',
    version: '1.0.0',
    mdDescription: 'Sets the compiled book title.',
    async invoke(env) {
      return withItem(env, { title, chapters: env.item })
    },
  })
}
