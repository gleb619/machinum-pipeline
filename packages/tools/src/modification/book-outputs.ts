import { category, defineTool, getVariable, tool, withItem } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'
import { chapterNumberOf } from '../normalization/glossary-extractor.js'
import { assertSummaryIsShort } from '../normalization/summary-bullets.js'
import { tagTerms } from '../normalization/term-tagger.js'
import { loadGlossaryOrEmpty, titleOf } from '../normalization/translation-stage.js'
import type { TitleTranslatorOutput } from './chapter-translator.js'

/**
 * Emits one `schema/chapter<N>.summary.md` per batched chapter.
 *
 * `createSummaryTool` publishes `summary` (first item) and `summaryByItem` (one per batched
 * input); this glue prefers the per-item values and keeps `summary` for a single chapter.
 */
export const writeSummaries = defineTool<unknown, string>({
  name: 'write-summaries',
  version: '1.1.0',
  description:
    'Emits schema/chapter<N>.summary.md from the `summaryByItem` variable (or `summary` for one chapter).',
  annotations: [
    tool('TL268', {
      name: 'write-summaries',
      description: 'Emits one schema/chapter<N>.summary.md per chapter.',
      refs: [],
    }),
    category(['serializer']),
  ],
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
  description: 'Emits glossary.json from the `glossaryJson` variable.',
  annotations: [
    tool('TL269', {
      name: 'write-glossary',
      description: 'Emits the editable glossary.json.',
      refs: ['UC060'],
    }),
    category(['serializer']),
  ],
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
  description: 'Emits titles.json from the translated title batch and the `chapters` variable.',
  annotations: [
    tool('TL270', {
      name: 'write-titles',
      description: 'Emits titles.json from the translated title batch.',
      refs: ['UC059'],
    }),
    category(['serializer']),
  ],
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
    description: 'Wraps glossary terms of every batched chapter in <term> tags.',
    annotations: [
      tool('TL271', {
        name: 'tag-with-glossary',
        description: 'Wraps glossary terms of every chapter in <term> tags.',
        refs: ['UC060'],
      }),
      category(['translator']),
    ],
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
  description: 'Sorts batched chapter markdown by chapter number.',
  annotations: [
    tool('TL272', {
      name: 'sort-chapters',
      description: 'Sorts batched chapter markdown by chapter number.',
      refs: [],
    }),
    category(['pipeline']),
  ],
  async invoke(env) {
    const chapters = (env.items ?? [env.item]).flat() as string[]
    const sorted = [...chapters].sort((left, right) => headingNumber(left) - headingNumber(right))
    return withItem(env, sorted)
  },
})
