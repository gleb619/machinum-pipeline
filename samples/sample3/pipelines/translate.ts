import { appendFileSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { definePipeline, defineTool, mapConcurrent } from '@mt/core'
import type { Tool } from '@mt/core'
import {
  type Glossary,
  LineParityError,
  type LineParityInput,
  type LineParityReport,
  type LlmRequest,
  type TranslateInput,
  type TranslateOutput,
  appendMdOutput,
  buildTranslationPrompt,
  chapterNumberOf,
  cleanTranslation,
  createTitleTranslator,
  joinReplyLines,
  lineParityLinter,
  lintLineParity,
  parseGlossary,
  stripTerms,
  tagTerms,
} from '@mt/tools'
import '@mt/waypoint'
import { pickLlmTool } from './llm-picker.js'

// === Translate stage: chapters/en-tagged/*.md -> chapters/ru/*.md (+ chapters/titles.json) ===
// 1. Titles: `titleTranslator` over batches of 5 chapters, glossary-aware -> chapters/titles.json.
// 2. Body: every non-empty line is translated on its own, SLOWLY (MT_TRANSLATE_CONCURRENCY,
//    default 1). The prompt carries the chapter summary (context only) and ONLY the glossary
//    entries whose <term id> occurs in that line.
// 3. Each line is linted on its own; a bad reply throws a retryable LineParityError, so the
//    engine retries (lines that already passed are memoised and not re-sent). The whole chapter
//    goes through `lineParityLinter` before it is written.
//
// Env: MT_LLM_TOOL / MT_LLM_MODEL (llm-picker; default offline mock), MT_TRANSLATE_CONCURRENCY,
// MT_ONLY_CHAPTERS (e.g. "1,3"), MT_TRANSLATE_PROMPT_LOG (mock only: jsonl of prompts).

const ROOT = resolve(import.meta.dirname, '..')
const CHAPTERS = join(ROOT, 'chapters')
const TITLES_PATH = join(CHAPTERS, 'titles.json')

/** Offline mock: words become "слово", `[brackets]` and punctuation stay. Logs prompts on demand. */
let mockCalls = 0
function mockAnswer(req: LlmRequest): string {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  mockCalls++
  // MT_MOCK_FLAKY=1: the first body-line answer is empty -> the line check must reject it.
  if (process.env.MT_MOCK_FLAKY === '1' && mockCalls === 3) return ''
  return user.replace(/[A-Za-z]+/g, 'слово')
}

const llm = pickLlmTool({ mockSource: mockAnswer })

/** Parsed `MT_ONLY_CHAPTERS` ("1,3"); `undefined` = all chapters. */
export function onlyChapters(env: Record<string, string | undefined> = process.env) {
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

async function loadGlossary(): Promise<Glossary> {
  try {
    return parseGlossary(await readFile(join(CHAPTERS, 'glossary.json'), 'utf-8')) ?? { terms: [] }
  } catch {
    return { terms: [] }
  }
}

/** Summary text of a chapter ("## Summary" section of schema/chapter<N>.summary.md). */
async function loadSummary(n: number): Promise<string> {
  try {
    const md = await readFile(join(CHAPTERS, 'schema', `chapter${n}.summary.md`), 'utf-8')
    return md.split(/^##\s+Summary\s*$/m)[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

const TITLE_RULES = [
  'The text is a chapter title: keep the chapter number, translate the word "Chapter" as "Глава".',
  'Output the title on a single line.',
]

/** LLM call for one prompt; returns the cleaned single-line-checked reply. */
async function ask(
  system: string,
  user: string,
  ctx: Parameters<typeof llm.schemaCall>[1],
): Promise<string> {
  const res = await llm.schemaCall(
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

/** Glossary-aware title translator slot for `titleTranslator` (plain text in, RU text out). */
function glossaryTitleTranslator(): Tool<TranslateInput, TranslateOutput> {
  return defineTool<TranslateInput, TranslateOutput>({
    name: 'glossary-title-translate',
    version: '1.0.0',
    mdDescription: 'Translates a chapter title through the picked LLM with glossary hints.',
    async invoke(env, ctx) {
      const title = env.item.text
      const glossary = await loadGlossary()
      const prompt = buildTranslationPrompt({
        text: tagTerms(title, glossary),
        glossary,
        extraRules: TITLE_RULES,
      })
      const ru = await ask(prompt.systemPrompt, prompt.userPrompt, ctx)
      const verdict = lintLineParity(title, ru, { cyrillicSeverity: 'error' })
      if (!verdict.ok) throw new LineParityError(verdict)
      return { item: { translatedText: ru }, meta: env.meta }
    },
  })
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

// --- pipeline steps -------------------------------------------------------------------------

/** Batch of tagged chapters -> title inputs for `titleTranslator`; chapters stay in meta. */
const toTitleInputs = defineTool<string[], { text: string; targetLang: string }>({
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

const lintedLines = (r: LineParityReport) => ({ errors: r.errors, warnings: r.warnings })

/** Heading text of `titleTranslator` output (it may wrap the heading in frontmatter). */
export function titleOf(text: string): string {
  const heading = [...text.matchAll(/^#\s+(.+)$/gm)].at(-1)?.[1]
  return (heading ?? text).trim()
}

/** Translated titles + tagged chapters -> `{ en, ru }` pairs (one per chapter). */
const translateChapters = (() => {
  const memo = new Map<string, string>() // survives engine retries of this step
  return defineTool<{ text: string }, LineParityInput>({
    name: 'translate-chapters',
    version: '1.0.0',
    mdDescription: 'Translates each tagged chapter line by line (glossary + summary injection).',
    async invoke(env, ctx) {
      const chapters = (env.meta.chapters as string[]) ?? []
      // titleTranslator's assemble slot returns a batch as `item: [...]` (no `items`)
      const outs = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
      const titles = outs.map((t) => titleOf(t.text))
      const glossary = await loadGlossary()
      const concurrency = translateConcurrency()
      const pairs: LineParityInput[] = []
      const nums: number[] = []
      for (const [i, tagged] of chapters.entries()) {
        const n = chapterNumberOf(tagged, i + 1)
        const t0 = Date.now()
        const ru = await translateTaggedChapter(tagged, {
          glossary,
          summary: await loadSummary(n),
          titleRu: titles[i] ?? '',
          concurrency,
          memo,
          ask: (system, user) => ask(system, user, ctx),
        })
        console.log(`[translate] chapter ${n}: ${Date.now() - t0} ms`)
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
})()

/** Runs `lineParityLinter` on every pair; throws (retryable) on the first hard error. */
const lintPairs = defineTool<LineParityInput, LineParityInput>({
  name: 'lint-chapter-pairs',
  version: '1.0.0',
  mdDescription: 'lineParityLinter over every EN/RU chapter pair; reports in meta.parityByChapter.',
  async invoke(env, ctx) {
    const pairs = env.items ?? [env.item]
    const nums = env.meta.chapterNums as number[]
    const reports: Record<string, ReturnType<typeof lintedLines>> = {}
    for (const [i, pair] of pairs.entries()) {
      const res = await lineParityLinter.invoke({ item: pair, meta: {} }, ctx)
      reports[String(nums[i])] = lintedLines(res.meta.parity as LineParityReport)
    }
    return { ...env, meta: { ...env.meta, parityByChapter: reports } }
  },
})

/** Existing chapters/titles.json ({ "<n>": { en, ru } }). */
function readTitles(): Record<string, { en: string; ru: string }> {
  try {
    return JSON.parse(readFileSync(TITLES_PATH, 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
  } catch {
    return {}
  }
}

/** Write intents: chapters/ru/chapter<N>.md and the merged chapters/titles.json. */
export const buildTranslateOutputs = defineTool<LineParityInput, string>({
  name: 'build-translate-outputs',
  version: '1.0.0',
  mdDescription: 'Emits chapters/ru/chapter<N>.md and chapters/titles.json.',
  async invoke(env) {
    const pairs = env.items ?? [env.item]
    const nums = env.meta.chapterNums as number[]
    const titlesRu = env.meta.titlesRu as string[]
    const titles = readTitles()
    let meta: Record<string, unknown> = { ...env.meta }
    pairs.forEach((pair, i) => {
      const n = nums[i]
      meta = appendMdOutput(meta, {
        name: 'ru',
        subdir: 'ru',
        filename: `chapter${n}.md`,
        content: pair.ru,
      })
      titles[String(n)] = {
        en: /^#\s+(.+)$/m.exec(pair.en)?.[1]?.trim() ?? '',
        ru: titlesRu[i] ?? '',
      }
    })
    meta = appendMdOutput(meta, {
      name: 'titles',
      subdir: '',
      filename: 'titles.json',
      content: `${JSON.stringify(titles, null, 2)}\n`,
    })
    console.log(`[translate] wrote ${pairs.length} chapter(s) [${nums.join(', ')}]`)
    return { item: '', meta }
  },
})

const only = onlyChapters()

const translateFlow = definePipeline()
  .from('md://./chapters/en-tagged')
  .flatMap(async (md: string) => (only && !only.has(chapterNumberOf(md, 0)) ? [] : [md]))
  .batch(5)
  .use(toTitleInputs)
  .use(createTitleTranslator({ translate: glossaryTitleTranslator() }) as never)
  .use(translateChapters)
  .use(lintPairs)
  .use(buildTranslateOutputs)
  .to('@chapters')

export { translateFlow }
export default translateFlow
