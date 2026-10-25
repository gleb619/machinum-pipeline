import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, mapConcurrent } from '@mt/core'
import type { Tool, ToolContext } from '@mt/core'
import type { TranslateInput, TranslateOutput } from '../core/translate-text.js'
import { LineParityError, lintLineParity } from '../verification/line-parity-linter.js'
import type { LineParityInput } from '../verification/line-parity-linter.js'
import { chapterNumberOf, parseGlossary } from './glossary-extractor.js'
import type { SchemaDocLlmCall } from './schema/llm.js'
import { stripTerms, tagTerms } from './term-tagger.js'
import type { Glossary } from './term-tagger.js'
import { buildTranslationPrompt, cleanTranslation, joinReplyLines } from './translation-prompt.js'

// Building blocks of the EN->RU chapter translate stage (titles + line by line body).
// Layout convention under `chaptersDir`: `glossary.json`, `schema/chapter<N>.summary.md`.

/** Parsed `MT_ONLY_CHAPTERS` ("1,3"); `undefined` = all chapters. */
export function onlyChapters(
  env: Record<string, string | undefined> = process.env,
): Set<number> | undefined {
  const nums = (env.MT_ONLY_CHAPTERS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return nums.length > 0 ? new Set(nums) : undefined
}

/** Paragraph concurrency (`MT_TRANSLATE_CONCURRENCY`, default 1 = slow and gentle). */
export function translateConcurrency(env: Record<string, string | undefined> = process.env) {
  const n = Number(env.MT_TRANSLATE_CONCURRENCY)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

/** `chaptersDir/glossary.json`, or an empty glossary when absent or malformed. */
export async function loadGlossaryOrEmpty(chaptersDir: string): Promise<Glossary> {
  try {
    return (
      parseGlossary(await readFile(join(chaptersDir, 'glossary.json'), 'utf-8')) ?? { terms: [] }
    )
  } catch {
    return { terms: [] }
  }
}

/** Summary text of a chapter (`## Summary` section of `chaptersDir/schema/chapter<N>.summary.md`). */
export async function loadChapterSummary(chaptersDir: string, n: number): Promise<string> {
  try {
    const md = await readFile(join(chaptersDir, 'schema', `chapter${n}.summary.md`), 'utf-8')
    return md.split(/^##\s+Summary\s*$/m)[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** One LLM call for a (system, user) prompt pair; returns the cleaned reply. */
async function ask(
  call: SchemaDocLlmCall,
  system: string,
  user: string,
  ctx: ToolContext,
): Promise<string> {
  const res = await call(
    {
      systemPrompt: system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxTokens: 2048,
    },
    ctx,
  )
  return cleanTranslation(res.content)
}

export const TITLE_RULES = [
  'The text is a chapter title: keep the chapter number, translate the word "Chapter" as "Глава".',
  'Output the title on a single line.',
]

export interface GlossaryTitleTranslatorOptions {
  call: SchemaDocLlmCall
  /** Directory with `glossary.json`. */
  chaptersDir: string
  /** Extra prompt rules. Default: {@link TITLE_RULES}. */
  rules?: string[]
}

/**
 * Glossary-aware title translator for `createTitleTranslator({ translate })`: plain text in,
 * RU text out. A reply that fails the line check throws a retryable {@link LineParityError}.
 */
export function createGlossaryTitleTranslator(
  options: GlossaryTitleTranslatorOptions,
): Tool<TranslateInput, TranslateOutput> {
  return defineTool<TranslateInput, TranslateOutput>({
    name: 'glossary-title-translate',
    version: '1.0.0',
    mdDescription: 'Translates a chapter title through the picked LLM with glossary hints.',
    async invoke(env, ctx) {
      const title = env.item.text
      const glossary = await loadGlossaryOrEmpty(options.chaptersDir)
      const prompt = buildTranslationPrompt({
        text: tagTerms(title, glossary),
        glossary,
        extraRules: options.rules ?? TITLE_RULES,
      })
      const ru = await ask(options.call, prompt.systemPrompt, prompt.userPrompt, ctx)
      const verdict = lintLineParity(title, ru, { cyrillicSeverity: 'error' })
      if (!verdict.ok) throw new LineParityError(verdict)
      return { item: { translatedText: ru }, meta: env.meta }
    },
  })
}

/** Batch of tagged chapters -> title inputs for `titleTranslator`; chapters stay in `meta.chapters`. */
export const chaptersToTitleInputs = defineTool<
  string[],
  { text: string; targetLang: string; sourceLang?: string }
>({
  name: 'chapters-to-title-inputs',
  version: '1.0.0',
  mdDescription: 'Stashes the tagged chapters in meta and emits one "# title" text per chapter.',
  async invoke(env) {
    const chapters = env.items ?? [env.item as unknown as string]
    const flat = chapters.flat() as string[]
    const items = flat.map((md) => {
      const heading = /^#\s+.+$/m.exec(md)?.[0] ?? '# Untitled'
      return { text: heading, targetLang: 'ru', sourceLang: 'en' }
    })
    return { item: items[0] as never, items, meta: { ...env.meta, chapters: flat } }
  },
})

/** Heading text of `titleTranslator` output (it may wrap the heading in frontmatter). */
export function titleOf(text: string): string {
  const heading = [...text.matchAll(/^#\s+(.+)$/gm)].at(-1)?.[1]
  return (heading ?? text).trim()
}

export interface TranslateLinesOptions {
  glossary: Glossary
  summary: string
  /** Translated `# ` heading text (without the `# `). */
  titleRu: string
  concurrency: number
  /** Sends one prompt, returns the cleaned reply. */
  ask: (system: string, user: string) => Promise<string>
  /** Per-line memo of replies that already passed the line check (retry skips them). */
  memo?: Map<string, string>
}

async function* lines<T>(xs: readonly T[]): AsyncIterable<T> {
  yield* xs
}

/**
 * Translates a `<term>`-tagged EN chapter line by line. Blank lines and fenced code are kept,
 * the first `# ` heading becomes `# <titleRu>`, every other line is one LLM call. A reply that
 * fails the single-line parity check throws a retryable {@link LineParityError}.
 */
export async function translateTaggedChapter(
  tagged: string,
  opts: TranslateLinesOptions,
): Promise<string> {
  const src = tagged.split('\n')
  let fence = false
  let headingDone = false
  const jobs: Array<{ index: number; text: string }> = []
  const out = [...src]
  src.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      return
    }
    if (fence || line.trim() === '') return
    if (!headingDone && /^#\s+/.test(line)) {
      headingDone = true
      out[index] = `# ${opts.titleRu}`
      return
    }
    jobs.push({ index, text: line })
  })

  const done = mapConcurrent(lines(jobs), opts.concurrency, async (job) => {
    const prompt = buildTranslationPrompt({
      text: job.text,
      glossary: opts.glossary,
      summary: opts.summary,
    })
    const key = JSON.stringify([prompt.systemPrompt, prompt.userPrompt])
    const hit = opts.memo?.get(key)
    if (hit !== undefined) return { index: job.index, ru: hit }
    // the model sometimes splits a long line: join it back (empty/bracket/other faults still fail)
    const ru = joinReplyLines(await opts.ask(prompt.systemPrompt, prompt.userPrompt))
    const verdict = lintLineParity(prompt.userPrompt, ru, { cyrillicSeverity: 'warn' })
    if (!verdict.ok) throw new LineParityError(verdict, `chapter line ${job.index + 1}`)
    opts.memo?.set(key, ru)
    return { index: job.index, ru }
  })
  for await (const { index, ru } of done) out[index] = ru
  return out.join('\n')
}

export interface ChapterBodyTranslatorOptions {
  call: SchemaDocLlmCall
  /** Directory with `glossary.json` and `schema/chapter<N>.summary.md`. */
  chaptersDir: string
  /** Paragraph concurrency. Default: `MT_TRANSLATE_CONCURRENCY` (1). */
  concurrency?: number
  /** Log per-chapter timing. Default: true. */
  log?: boolean
}

/**
 * Body step after `titleTranslator`: translates every tagged chapter of `meta.chapters` line by
 * line (glossary + summary injection) and emits `{ en, ru }` pairs (`items`) plus
 * `meta.chapterNums` / `meta.titlesRu`. Replies that passed the line check are memoised, so
 * engine retries only re-send the failed lines.
 */
export function createChapterBodyTranslator(options: ChapterBodyTranslatorOptions) {
  const memo = new Map<string, string>() // survives engine retries of this step
  return defineTool<{ text: string }, LineParityInput>({
    name: 'chapter-body-translator',
    version: '1.0.0',
    mdDescription: 'Translates each tagged chapter line by line (glossary + summary injection).',
    async invoke(env, ctx) {
      const chapters = (env.meta.chapters as string[]) ?? []
      // titleTranslator's assemble slot returns a batch as `item: [...]` (no `items`)
      const outs = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
      const titles = outs.map((t) => titleOf(t.text))
      const glossary = await loadGlossaryOrEmpty(options.chaptersDir)
      const concurrency = options.concurrency ?? translateConcurrency()
      const pairs: LineParityInput[] = []
      const nums: number[] = []
      for (const [i, tagged] of chapters.entries()) {
        const n = chapterNumberOf(tagged, i + 1)
        const t0 = Date.now()
        const ru = await translateTaggedChapter(tagged, {
          glossary,
          summary: await loadChapterSummary(options.chaptersDir, n),
          titleRu: titles[i] ?? '',
          concurrency,
          memo,
          ask: (system, user) => ask(options.call, system, user, ctx),
        })
        if (options.log !== false) console.log(`[translate] chapter ${n}: ${Date.now() - t0} ms`)
        pairs.push({ en: stripTerms(tagged), ru })
        nums.push(n)
      }
      return {
        item: pairs[0] as LineParityInput,
        items: pairs,
        meta: { ...env.meta, chapterNums: nums, titlesRu: titles },
      }
    },
  })
}
