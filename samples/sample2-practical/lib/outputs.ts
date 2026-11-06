import { defineTool, getVariable, withItem } from '@mt/core'
import {
  type TitleTranslatorOutput,
  appendMdOutput,
  chapterNumberOf,
  loadGlossaryOrEmpty,
  tagTerms,
  titleOf,
} from '@mt/tools'

/** Emits one `schema/chapter<N>.summary.md` per batched chapter. */
export const writeSummaries = defineTool<unknown, string>({
  name: 'write-summaries',
  version: '1.0.0',
  mdDescription: 'Emits schema/chapter<N>.summary.md from the `summaryByItem` variable.',
  async invoke(env) {
    const chapters = (env.items ?? [env.item]).flat() as string[]
    const summaries = getVariable<string[]>(env, 'summaryByItem') ?? []
    let out = withItem(env, '')
    chapters.forEach((markdown, index) => {
      const number = chapterNumberOf(markdown, index + 1)
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? `Chapter ${number}`
      out = appendMdOutput(out, {
        name: 'summary',
        subdir: 'schema',
        filename: `chapter${number}.summary.md`,
        content: `# ${title}\n\n## Summary\n\n${summaries[index] ?? ''}\n`,
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
