import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  category,
  defineTool,
  mapConcurrent,
  setVariable,
  setVariables,
  tool,
  useCase,
  withItem,
} from '@mt/core'
import type { Tool, ToolContext } from '@mt/core'
import { LlmError } from '../core/llm-errors.js'
import { resolveProcessLlm } from '../core/llm-install.js'
import { extractXmlResultEntries } from '../core/prompt-blocks.js'
import type { TranslateInput, TranslateOutput } from '../core/translate-text.js'
import { LineParityError, lintLineParity } from '../verification/line-parity-linter.js'
import type { LineParityInput } from '../verification/line-parity-linter.js'
import { exField } from './fields.js'
import { chapterNumberOf, parseGlossary } from './glossary-extractor.js'
import type { SchemaDocLlmCall } from './schema/llm.js'
import { countTerms, stripTerms, tagTerms } from './term-tagger.js'
import type { Glossary, GlossaryTerm } from './term-tagger.js'
import type { TranslateWorkMode } from './translation-prompt.js'
import {
  buildTranslationPrompt,
  cleanTranslation,
  joinReplyLines,
  termIdsIn,
  translateTermsEnabled,
} from './translation-prompt.js'
import { TranslationReplyParseError } from './translation-reply.js'
import { parseTranslationReply } from './translation-reply.js'

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

/** Lines per body-translation request (`MT_TRANSLATE_BLOCK_LINES`, default 6). */
export const DEFAULT_TRANSLATE_BLOCK_LINES = 6

/**
 * Largest block a free-tier model was measured to hold without structural drift. Above it the
 * model drops or duplicates lines, the whole block fails the line check and every block falls
 * back to per-line requests (7-14 calls per 16-line chapter instead of 3).
 */
export const TRANSLATE_BLOCK_LINES_SAFE_MAX = 8

/** Body-translation block size (`MT_TRANSLATE_BLOCK_LINES`, default 6). */
export function translateBlockLines(env: Record<string, string | undefined> = process.env) {
  const n = Number(env.MT_TRANSLATE_BLOCK_LINES)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_TRANSLATE_BLOCK_LINES
}

/** One `warn` for a block size the free tier cannot hold; `undefined` when the size is safe. */
export function translateBlockLinesWarning(blockLines: number): string | undefined {
  if (blockLines <= TRANSLATE_BLOCK_LINES_SAFE_MAX) return undefined
  return `blockLines=${blockLines} exceeds the measured safe size ${TRANSLATE_BLOCK_LINES_SAFE_MAX}: free-tier models drop or duplicate lines, so every block falls back to per-line requests (7-14 calls per 16-line chapter instead of 3)`
}

/**
 * `chaptersDir/glossary.json`, or an empty glossary only when the file does not exist. A file
 * that exists but cannot be read or parsed throws: silently translating a whole book without
 * its pinned terms is worse than failing.
 */
export async function loadGlossaryOrEmpty(chaptersDir: string): Promise<Glossary> {
  const path = join(chaptersDir, 'glossary.json')
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { terms: [] }
    throw new Error(
      `failed to read glossary ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  const glossary = parseGlossary(text)
  if (!glossary) throw new Error(`failed to parse glossary ${path}: expected {"terms": [...]}`)
  return glossary
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

/** Prompt-context slots the chapter body translator can inject. */
export type TranslateSlot = 'summary' | 'glossary' | 'ner' | 'vocab' | 'priorTerms'

/** Every slot, in prompt order (the order the blocks appear in `translate.system`). */
export const TRANSLATE_SLOTS: readonly TranslateSlot[] = [
  'summary',
  'glossary',
  'ner',
  'vocab',
  'priorTerms',
]

/**
 * Parsed `MT_TRANSLATE_SLOTS` (comma list, e.g. `summary,ner`); empty/absent = all slots.
 * An unknown name throws: a typo must not silently drop a slot from every prompt.
 */
export function translateSlots(
  env: Record<string, string | undefined> = process.env,
): TranslateSlot[] {
  const raw = (env.MT_TRANSLATE_SLOTS ?? '').trim()
  if (raw === '') return [...TRANSLATE_SLOTS]
  const out: TranslateSlot[] = []
  for (const part of raw.split(',')) {
    const name = part.trim()
    if (name === '') continue
    const slot = TRANSLATE_SLOTS.find((s) => s === name)
    if (slot === undefined) {
      throw new Error(
        `unknown MT_TRANSLATE_SLOTS value '${name}': expected ${TRANSLATE_SLOTS.join('|')}`,
      )
    }
    if (!out.includes(slot)) out.push(slot)
  }
  return out
}

/** `MT_TRANSLATE_SLOTS_STRICT=1`: a missing slot artefact is an error instead of a warning. */
export function translateSlotsStrict(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MT_TRANSLATE_SLOTS_STRICT === '1'
}

/** Hard cap of the rendered entity block (roadmap step 8). */
export const ENTITY_BLOCK_CAP = 1500
/** Hard cap of the rendered recurring-term block. */
export const VOCAB_BLOCK_CAP = 800
/** Book-wide fallback size for vocabulary terms that carry no `chapters[]`. */
export const VOCAB_BOOK_TOP = 20

export const ENTITY_BLOCK_HEADER =
  'Named entities in this chapter (keep spelling and gender consistent):'
export const VOCAB_BLOCK_HEADER = 'Recurring terms (translate the same way every time):'

/** Minimal entity shape the block renderer needs (the stage artefact carries more). */
export interface SlotEntity {
  name: string
  kind: string
  aliases?: string[]
}

/** Minimal vocabulary-term shape the block renderer needs. */
export interface SlotVocabTerm {
  term: string
  kind: string
  count: number
  chapters?: number[]
}

/** Renders entities in artefact order (rank), dropping whole lines past `cap` characters. */
export function renderEntityBlock(
  entities: readonly SlotEntity[],
  cap: number = ENTITY_BLOCK_CAP,
): string {
  const lines = [ENTITY_BLOCK_HEADER]
  let size = ENTITY_BLOCK_HEADER.length
  for (const entity of entities) {
    const aliases = (entity.aliases ?? []).map((a) => a.trim()).filter((a) => a !== '')
    const meta = aliases.length > 0 ? `${entity.kind}; aliases: ${aliases.join(', ')}` : entity.kind
    const line = `- ${entity.name} (${meta})`
    if (size + 1 + line.length > cap) break
    lines.push(line)
    size += 1 + line.length
  }
  return lines.join('\n')
}

/**
 * Renders the recurring terms of chapter `chapter` in artefact order, dropping whole lines past
 * `cap`. A term without `chapters[]` is book-wide: it participates through the book top-N.
 */
export function renderVocabBlock(
  terms: readonly SlotVocabTerm[],
  chapter: number,
  cap: number = VOCAB_BLOCK_CAP,
): string {
  const bookTop = new Set(
    terms
      .filter((t) => t.chapters === undefined || t.chapters.length === 0)
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, VOCAB_BOOK_TOP)
      .map((t) => t.term),
  )
  const lines = [VOCAB_BLOCK_HEADER]
  let size = VOCAB_BLOCK_HEADER.length
  for (const term of terms) {
    if (!(term.chapters?.includes(chapter) || bookTop.has(term.term))) continue
    const line = `${term.term} (${term.kind}, ×${term.count})`
    if (size + 1 + line.length > cap) break
    lines.push(line)
    size += 1 + line.length
  }
  return lines.join('\n')
}

/** Reads a slot artefact: absent = `''` + one warn (strict: throw); unreadable/unparsable: throw. */
async function readSlotFile(
  path: string,
  slot: TranslateSlot,
  chapter: number,
  ctx: ToolContext,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      throw new Error(
        `failed to read ${slot} slot ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    const message = `[translate] chapter ${chapter}: missing ${slot} slot file ${path}, injecting an empty block`
    if (translateSlotsStrict(env)) throw new Error(message)
    ctx.run.logger.warn(message)
    return undefined
  }
}

function parseSlotJson(text: string, path: string, slot: TranslateSlot): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(
      `failed to parse ${slot} slot ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string')
}

function numberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is number => typeof v === 'number')
}

/**
 * Named-entity block of a chapter (`chaptersDir/schema/chapter<N>.entities.json`). The file is
 * absent before the NER stage: the block degrades to `''` with one warning (strict: throw).
 */
export async function loadChapterEntities(
  chaptersDir: string,
  n: number,
  ctx: ToolContext,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const path = join(chaptersDir, 'schema', `chapter${n}.entities.json`)
  const text = await readSlotFile(path, 'ner', n, ctx, env)
  if (text === undefined) return ''
  const raw = asRecord(parseSlotJson(text, path, 'ner'))?.entities
  if (!Array.isArray(raw)) {
    throw new Error(`failed to parse ner slot ${path}: expected {"entities": [...]}`)
  }
  const entities: SlotEntity[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const name = typeof rec?.name === 'string' ? rec.name.trim() : ''
    if (name === '') continue
    entities.push({
      name,
      kind: typeof rec?.kind === 'string' ? rec.kind : 'entity',
      aliases: stringList(rec?.aliases),
    })
  }
  return renderEntityBlock(entities)
}

/**
 * Recurring-term block of a chapter (`chaptersDir/schema/vocabulary.json`), restricted to the
 * terms whose `chapters[]` contains `n`. Absent file = `''` + one warning (strict: throw).
 */
export async function loadChapterVocabulary(
  chaptersDir: string,
  n: number,
  ctx: ToolContext,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const path = join(chaptersDir, 'schema', 'vocabulary.json')
  const text = await readSlotFile(path, 'vocab', n, ctx, env)
  if (text === undefined) return ''
  const raw = asRecord(parseSlotJson(text, path, 'vocab'))?.terms
  if (!Array.isArray(raw)) {
    throw new Error(`failed to parse vocab slot ${path}: expected {"terms": [...]}`)
  }
  const terms: SlotVocabTerm[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const term = typeof rec?.term === 'string' ? rec.term.trim() : ''
    if (term === '') continue
    terms.push({
      term,
      kind: typeof rec?.kind === 'string' ? rec.kind : 'term',
      count: typeof rec?.count === 'number' ? rec.count : 0,
      chapters: numberList(rec?.chapters),
    })
  }
  return renderVocabBlock(terms, n)
}

/** Output budget of a translation request when the caller sets none. */
const DEFAULT_TRANSLATE_MAX_TOKENS = 2048

/**
 * One LLM call for a (system, user) prompt pair, returning the raw model content. A reply cut
 * off at `maxTokens` throws a retryable {@link LlmError}; thinking models need a larger budget.
 */
async function askRawContent(
  call: SchemaDocLlmCall,
  system: string,
  user: string,
  ctx: ToolContext,
  maxTokens: number = DEFAULT_TRANSLATE_MAX_TOKENS,
): Promise<string> {
  const res = await call(
    {
      systemPrompt: system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxTokens,
    },
    ctx,
  )
  if (res.finishReason === 'length' || res.content.trim() === '') {
    debugDump(
      undefined,
      'llm-meta',
      JSON.stringify({
        finishReason: res.finishReason ?? null,
        contentLength: res.content.length,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        maxTokens,
        systemChars: system.length,
        userChars: user.length,
      }),
    )
  }
  if (res.finishReason === 'length') {
    throw new LlmError('translation reply truncated at maxTokens (finishReason: length)', {
      retryable: true,
    })
  }
  // A thinking model that spends its whole budget on reasoning returns an empty `content` with
  // a normal stop reason. Treating that as a successful reply produced a blank "translation"
  // that only surfaced later as a confusing line-parity error.
  if (res.content.trim() === '') {
    throw new LlmError(
      `empty translation reply (finishReason: ${res.finishReason ?? 'unknown'}, completionTokens: ${res.completionTokens})`,
      { retryable: true },
    )
  }
  return res.content
}

/**
 * One LLM call for a (system, user) prompt pair. `mode: 'plain'` (default) returns the cleaned
 * reply as before; other modes parse the structured reply (xml/properties) and join the
 * translated lines with `\n`; a reply with missing/duplicate ids/keys throws a retryable
 * {@link TranslationReplyParseError}.
 */
async function ask(
  call: SchemaDocLlmCall,
  system: string,
  user: string,
  ctx: ToolContext,
  mode: TranslateWorkMode = 'plain',
  maxTokens: number = DEFAULT_TRANSLATE_MAX_TOKENS,
): Promise<string> {
  const content = await askRawContent(call, system, user, ctx, maxTokens)
  if (mode === 'plain') return cleanTranslation(content)
  return parseTranslationReply(content, mode).lines.join('\n')
}

export const TITLE_RULES = [
  'The text is a chapter title: keep the chapter number, translate the word "Chapter" as "Глава".',
  'Output the title on a single line.',
]

export interface GlossaryTitleTranslatorOptions {
  /**
   * LLM backend. Optional: an explicit `call` always wins; when omitted, the process-level
   * pick is used at invoke time (`resolveProcessLlm()?.schemaCall`), exactly like
   * {@link runPromptWithRetry}. Without either the tool throws instead of falling back.
   */
  call?: SchemaDocLlmCall
  /** Directory with `glossary.json`. */
  chaptersDir: string
  /** Extra prompt rules. Default: {@link TITLE_RULES}. */
  rules?: string[]
  /** Work mode of the translation prompt. Default: `'plain'` (backward compatible). */
  mode?: TranslateWorkMode
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
    version: '1.2.0',
    description:
      'Translates a chapter title through the picked LLM with glossary hints (optional work mode).',
    async invoke(env, ctx) {
      const call = options.call ?? resolveProcessLlm()?.schemaCall
      if (call === undefined) {
        throw new Error(
          'createGlossaryTitleTranslator: no LLM backend - pass `call` or install a process LLM provider',
        )
      }
      const title = env.item.text
      const glossary = await loadGlossaryOrEmpty(options.chaptersDir)
      const prompt = buildTranslationPrompt({
        text: tagTerms(title, glossary),
        glossary,
        extraRules: options.rules ?? TITLE_RULES,
        mode: options.mode,
        terms: translateTermsEnabled(),
      })
      const ru = await ask(call, prompt.systemPrompt, prompt.userPrompt, ctx, options.mode)
      const verdict = lintLineParity(title, ru, { cyrillicSeverity: 'error' })
      if (!verdict.ok) throw new LineParityError(verdict)
      return withItem(env, { translatedText: ru })
    },
  })
}

/** Batch of tagged chapters -> title inputs for `titleTranslator`; chapters stay in variable `chapters`. */
export const chaptersToTitleInputs = defineTool<
  string[],
  { text: string; targetLang: string; sourceLang?: string }
>({
  name: 'chapters-to-title-inputs',
  version: '1.0.0',
  description:
    'Stashes the tagged chapters in a variable and emits one "# title" text per chapter.',
  annotations: [
    tool('TL207', {
      name: 'chapters-to-title-inputs',
      description: 'Emits one title input per chapter for batch translation.',
      refs: ['UC059'],
    }),
    useCase('UC059'),
    category(['pipeline']),
  ],
  async invoke(env) {
    const chapters = env.items ?? [env.item as unknown as string]
    const flat = chapters.flat() as string[]
    const items = flat.map((md) => {
      const heading = /^#\s+.+$/m.exec(md)?.[0] ?? '# Untitled'
      return { text: heading, targetLang: 'ru', sourceLang: 'en' }
    })
    return setVariable({ ...withItem(env, items[0] as never), items }, 'chapters', flat)
  },
})

/** Heading text of `titleTranslator` output (it may wrap the heading in frontmatter). */
export function titleOf(text: string): string {
  const heading = [...text.matchAll(/^#\s+(.+)$/gm)].at(-1)?.[1]
  return (heading ?? text).trim()
}

/** One non-blank body line of a chapter, with its index in the source line array. */
interface LineJob {
  index: number
  text: string
}

/** Per-chapter request accounting (logged as `translate chapter=… lines=… calls=…`). */
export interface TranslateChapterStats {
  /** Non-blank body lines of the chapter (the heading and fenced code excluded). */
  lines: number
  /** LLM requests actually sent: memo hits, skipped and replayed lines are not counted. */
  calls: number
  /** Lines recovered with a per-line request after their block failed. */
  fallbackLines: number
}

export interface TranslateLinesOptions {
  glossary: Glossary
  summary: string
  /**
   * Ask the model for the `<terms>[]</terms>` report. Default: `translateTermsEnabled()`
   * (`MT_TRANSLATE_TERMS=off` disables).
   */
  terms?: boolean
  /** Pre-rendered named-entity block; empty = no block. */
  entities?: string
  /** Pre-rendered recurring-term block; empty = no block. */
  vocabulary?: string
  /** Pre-rendered "terms established in earlier chapters" block; empty = no block. */
  priorTerms?: string
  /** Chapter number of `tagged`: term state (ru/gender timelines) resolves at this chapter. */
  chapter?: number
  /** Translated `# ` heading text (without the `# `). */
  titleRu: string
  concurrency: number
  /** Sends one prompt, returns the cleaned reply. */
  ask: (system: string, user: string) => Promise<string>
  /**
   * Sends one prompt, returns the raw model content (no clean/parse). Block mode needs the raw
   * structured reply to recover the lines a partial reply did produce; it falls back to `ask`
   * when absent, which only works if `ask` returns that raw reply.
   */
  askRaw?: (system: string, user: string) => Promise<string>
  /** Per-line memo of replies that already passed the line check (retry skips them). */
  memo?: Map<string, string>
  /** Work mode of the per-line translation prompt. Default: `'plain'` (backward compatible). */
  mode?: TranslateWorkMode
  /**
   * Consecutive body lines per LLM request in `xml` mode. Default `1` = one request per line
   * (historical behaviour). A failed block is retried once; its still-failing lines then fall
   * back to per-line requests, so a chapter keeps its 1:1 line mapping either way.
   */
  blockLines?: number
  /** Output budget of every request. Default 2048; raise it for thinking models. */
  maxTokens?: number
  /** Called once per chapter, also when a line fails (the engine then retries the step). */
  onStats?: (stats: TranslateChapterStats) => void
}

async function* lines<T>(xs: readonly T[]): AsyncIterable<T> {
  yield* xs
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Root of the `MT_TRANSLATE_DEBUG=1` dumps (block prompt, raw reply, parsed candidates). */
const DEBUG_DIR = '/tmp/mt-translate-debug'
let debugSeq = 0

/**
 * Writes one debugging artefact to `/tmp/mt-translate-debug/<chapter>/<seq>-<name>.txt`.
 * `MT_TRANSLATE_DEBUG=1` only; never throws (a failed dump must not fail a translation).
 */
function debugDump(chapter: number | undefined, name: string, text: string): void {
  if (process.env.MT_TRANSLATE_DEBUG !== '1') return
  try {
    const dir = join(DEBUG_DIR, String(chapter ?? 0))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${String(++debugSeq).padStart(3, '0')}-${name}.txt`), text)
  } catch {
    // diagnostics only
  }
}

function linePrompt(job: LineJob, opts: TranslateLinesOptions) {
  return buildTranslationPrompt({
    text: job.text,
    glossary: opts.glossary,
    summary: opts.summary,
    entities: opts.entities,
    vocabulary: opts.vocabulary,
    priorTerms: opts.priorTerms,
    mode: opts.mode,
    chapter: opts.chapter,
    terms: opts.terms,
  })
}

function promptKey(prompt: { systemPrompt: string; userPrompt: string }): string {
  return JSON.stringify([prompt.systemPrompt, prompt.userPrompt])
}

/** Translates one body line (plain single-line request), reusing the per-line memo. */
async function translateLine(
  job: LineJob,
  opts: TranslateLinesOptions,
  stats: TranslateChapterStats,
): Promise<string> {
  const prompt = linePrompt(job, opts)
  const key = promptKey(prompt)
  const hit = opts.memo?.get(key)
  if (hit !== undefined) return hit
  stats.calls += 1
  // plain mode: the model sometimes splits a long line: join it back (empty/bracket/other
  // faults still fail); other modes already return exactly one line per input line
  const reply = await opts.ask(prompt.systemPrompt, prompt.userPrompt)
  // The prompt asks for the translation plus one trailing `<terms>` report block, and the
  // model obeys literally: without this cleanup the block lands in the chapter text.
  const clean = cleanTranslation(reply)
  const ru = opts.mode === undefined || opts.mode === 'plain' ? joinReplyLines(clean) : clean
  // parity is checked against the source line, not the (mode-wrapped) user prompt
  const verdict = lintLineParity(stripTerms(job.text), ru, {
    cyrillicSeverity: 'warn',
    untranslatedSeverity: 'error',
  })
  if (!verdict.ok) {
    debugDump(
      opts.chapter,
      `line-${job.index + 1}-fail`,
      `${verdict.issues.map((i) => `${i.severity} ${i.code}: ${i.message}`).join('\n')}\n--- src ---\n${job.text}\n--- ru ---\n${ru}\n`,
    )
    throw new LineParityError(verdict, `chapter line ${job.index + 1}`)
  }
  opts.memo?.set(key, ru)
  return ru
}

/**
 * One reply value as a candidate line: `undefined` when it is empty or spans several lines.
 * A value carrying an embedded newline means the model merged or split source lines; keeping it
 * would either add a chapter line or silently swallow the neighbouring one, so the line is left
 * to the per-line fallback instead.
 */
function candidateLine(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('\n')) return undefined
  return trimmed
}

/**
 * Extracts the `<id>…<translated>` pairs of an `xml` block reply, keyed by the id the reply
 * carries (never by document position, so a reordered, duplicated or missing entry cannot shift
 * the later lines). A reply with no `<id>` at all falls back to document order. Missing,
 * duplicated and multi-line entries stay `undefined` so the other lines of a partial reply can
 * still be kept.
 */
function blockCandidates(reply: string, count: number): Array<string | undefined> {
  const cleaned = cleanTranslation(reply)
  const entries = extractXmlResultEntries(cleaned, 'translated')
  const byId = new Map<number, string>()
  const duplicate = new Set<number>()
  for (const entry of entries) {
    if (byId.has(entry.key)) duplicate.add(entry.key)
    else byId.set(entry.key, entry.value)
  }
  const positional =
    entries.length === 0
      ? [...cleaned.matchAll(/<translated>([\s\S]*?)<\/translated>/g)].map((m) => m[1] ?? '')
      : undefined
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1
    const raw = positional === undefined ? byId.get(id) : positional[i]
    if (raw === undefined || duplicate.has(id)) return undefined
    return candidateLine(raw)
  })
}

/** Lines of a block reply that are present and pass the single-line parity check. */
function passingBlockLines(block: readonly LineJob[], reply: string): Map<number, string> {
  const candidates = blockCandidates(reply, block.length)
  const passed = new Map<number, string>()
  block.forEach((job, i) => {
    const ru = candidates[i]
    if (ru === undefined) return
    const verdict = lintLineParity(stripTerms(job.text), ru, {
      cyrillicSeverity: 'warn',
      untranslatedSeverity: 'error',
    })
    if (verdict.ok) passed.set(job.index, ru)
  })
  return passed
}

/**
 * Translates one block of consecutive lines in `xml` mode. One retry of the whole block, then a
 * per-line request for every line the block still did not return; lines that passed are kept.
 * A line whose per-line reply also fails parity throws the retryable {@link LineParityError}.
 */
async function translateBlock(
  block: readonly LineJob[],
  opts: TranslateLinesOptions,
  stats: TranslateChapterStats,
): Promise<Map<number, string>> {
  const send = opts.askRaw ?? opts.ask
  const prompt = buildTranslationPrompt({
    text: block.map((job) => job.text).join('\n'),
    glossary: opts.glossary,
    summary: opts.summary,
    entities: opts.entities,
    vocabulary: opts.vocabulary,
    priorTerms: opts.priorTerms,
    mode: 'xml',
    chapter: opts.chapter,
    terms: opts.terms,
  })
  const passed = new Map<number, string>()
  const attempt = async () => {
    stats.calls += 1
    debugDump(
      opts.chapter,
      'block-prompt',
      `${prompt.systemPrompt}\n\n===== USER =====\n\n${prompt.userPrompt}`,
    )
    const reply = await send(prompt.systemPrompt, prompt.userPrompt)
    debugDump(opts.chapter, 'block-reply', reply)
    debugDump(
      opts.chapter,
      'block-candidates',
      JSON.stringify(
        { block: block.map((job) => job.text), candidates: blockCandidates(reply, block.length) },
        null,
        2,
      ),
    )
    for (const [index, ru] of passingBlockLines(block, reply)) {
      if (!passed.has(index)) passed.set(index, ru)
    }
  }
  // A truncated reply throws LlmError, a garbled one yields no/missing ids: retry the block once
  // before paying for per-line requests.
  try {
    await attempt()
  } catch {
    // the retry below decides whether this is recoverable
  }
  if (passed.size < block.length) {
    try {
      await attempt()
    } catch {
      // still failing: per-line fallback below recovers the lines one by one
    }
  }
  // Memoise block results under the ordinary per-line key, so a resumed run re-sends nothing.
  for (const job of block) {
    const ru = passed.get(job.index)
    if (ru !== undefined) opts.memo?.set(promptKey(linePrompt(job, opts)), ru)
  }
  for (const job of block) {
    if (passed.has(job.index)) continue
    stats.fallbackLines += 1
    passed.set(job.index, await translateLine(job, opts, stats))
  }
  return passed
}

/** Terms a prompt can pin: entries carrying a RU rendering. */
export function pinnedTerms(glossary: Glossary): GlossaryTerm[] {
  return glossary.terms.filter((t) => t.ru !== null && t.ru.trim() !== '')
}

/**
 * Fails loudly when a chapter with pinned glossary terms reaches the translator untagged: the
 * prompt would carry an empty glossary block and the model would transliterate on its own
 * (`Надия`, `Дойл`) instead of using the pinned forms (`Надя`, `Доул`). A chapter with no
 * occurrence of any pinned term is still fine untagged.
 */
function assertGlossaryTags(tagged: string, glossary: Glossary): void {
  const pinned = pinnedTerms(glossary)
  if (pinned.length === 0 || termIdsIn(tagged).length > 0) return
  const occurrences = countTerms(stripTerms(tagged), { terms: pinned })
  if (occurrences.size === 0) return
  throw new Error(
    `translate: ${occurrences.size} pinned glossary term(s) occur in the chapter text but no <term> tag is present; the chapter was not tagged before translation (glossary has ${pinned.length} pinned term(s))`,
  )
}

/**
 * Translates a `<term>`-tagged EN chapter. Blank lines and fenced code are kept, the first `# `
 * heading becomes `# <titleRu>`. With the default `blockLines: 1` every other line is one LLM
 * call; `blockLines > 1` groups consecutive lines into `xml`-mode requests of that size, keeps
 * the 1:1 line mapping, and falls back to per-line requests for lines a block cannot deliver.
 */
export async function translateTaggedChapter(
  tagged: string,
  opts: TranslateLinesOptions,
): Promise<string> {
  assertGlossaryTags(tagged, opts.glossary)
  const src = tagged.split('\n')
  let fence = false
  let headingDone = false
  const jobs: LineJob[] = []
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

  const stats: TranslateChapterStats = { lines: jobs.length, calls: 0, fallbackLines: 0 }
  const blockLines = Math.max(1, Math.floor(opts.blockLines ?? 1))
  try {
    if (blockLines <= 1) {
      const done = mapConcurrent(lines(jobs), opts.concurrency, async (job) => ({
        index: job.index,
        ru: await translateLine(job, opts, stats),
      }))
      for await (const { index, ru } of done) out[index] = ru
    } else {
      const pending: LineJob[] = []
      for (const job of jobs) {
        const hit = opts.memo?.get(promptKey(linePrompt(job, opts)))
        if (hit !== undefined) out[job.index] = hit
        else pending.push(job)
      }
      const done = mapConcurrent(lines(chunk(pending, blockLines)), opts.concurrency, (block) =>
        translateBlock(block, opts, stats),
      )
      for await (const results of done) {
        for (const [index, ru] of results) out[index] = ru
      }
    }
  } catch (err) {
    const numbered = (ls: readonly string[]) => ls.map((l, i) => `${i + 1}|${l}`).join('\n')
    debugDump(opts.chapter, 'chapter-src', numbered(src))
    debugDump(opts.chapter, 'chapter-partial', numbered(out))
    throw err
  } finally {
    opts.onStats?.(stats)
  }
  return out.join('\n')
}

export interface ChapterBodyTranslatorOptions {
  /**
   * LLM backend. Optional: an explicit `call` always wins; when omitted, the process-level
   * pick is used at invoke time (`resolveProcessLlm()?.schemaCall`), exactly like
   * {@link runPromptWithRetry}. Without either the tool throws instead of falling back.
   */
  call?: SchemaDocLlmCall
  /** Directory with `glossary.json` and `schema/{chapter<N>.summary.md, chapter<N>.entities.json, vocabulary.json}`. */
  chaptersDir: string
  /** Paragraph concurrency. Default: `MT_TRANSLATE_CONCURRENCY` (1). */
  concurrency?: number
  /** Log one request-accounting line per chapter. Default: true. */
  log?: boolean
  /** Work mode of the translation prompt. Default: `'plain'` (backward compatible). */
  mode?: TranslateWorkMode
  /**
   * Prompt-context slots to inject. Default: `MT_TRANSLATE_SLOTS`, else all four
   * ({@link TRANSLATE_SLOTS}). Disabled slots are neither read nor rendered.
   */
  slots?: TranslateSlot[]
  /**
   * Consecutive body lines per LLM request (`xml` mode). Default `1` = one request per line.
   * Block mode cuts the free-tier request count by ~10× while keeping per-line verification.
   * Above {@link TRANSLATE_BLOCK_LINES_SAFE_MAX} the step logs one `warn`: free-tier models
   * drift on structure, so the size is a measured trade-off, not a free win.
   */
  blockLines?: number
  /** Output budget of every request. Default 2048; raise it for thinking models. */
  maxTokens?: number
  /**
   * Renders the "terms established in earlier chapters" block for the chapter being translated.
   * Absent = no block (default behaviour).
   */
  priorTerms?: (chapter: number) => string
}

/**
 * Body step after `titleTranslator`: translates every tagged chapter of `meta.chapters` line by
 * line (glossary + summary injection) and emits `{ en, ru }` pairs (`items`) plus
 * variables `chapterNums` / `titlesRu`. Replies that passed the line check are memoised, so
 * engine retries only re-send the failed lines.
 */
export function createChapterBodyTranslator(options: ChapterBodyTranslatorOptions) {
  const memo = new Map<string, string>() // survives engine retries of this step
  let warnedBlockLines = false
  return defineTool<{ text: string }, LineParityInput>({
    name: 'chapter-body-translator',
    version: '1.3.0',
    description:
      'Translates each tagged chapter line by line, or in measured blocks (glossary + summary injection, optional work mode).',
    async invoke(env, ctx) {
      const call = options.call ?? resolveProcessLlm()?.schemaCall
      if (call === undefined) {
        throw new Error(
          'createChapterBodyTranslator: no LLM backend - pass `call` or install a process LLM provider',
        )
      }
      const chapters = exField<string[]>(env, 'chapters') ?? []
      // titleTranslator's assemble slot returns a batch as `item: [...]` (no `items`)
      const outs = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
      const titles = outs.map((t) => titleOf(t.text))
      const slots = new Set(options.slots ?? translateSlots())
      const glossary = slots.has('glossary')
        ? await loadGlossaryOrEmpty(options.chaptersDir)
        : { terms: [] }
      const concurrency = options.concurrency ?? translateConcurrency()
      const blockLines = Math.max(1, Math.floor(options.blockLines ?? 1))
      if (!warnedBlockLines) {
        const warning = translateBlockLinesWarning(blockLines)
        if (warning) {
          warnedBlockLines = true
          ctx.run.logger.warn(`[translate] ${warning}`)
        }
      }
      const pinned = pinnedTerms(glossary).length
      const pairs: LineParityInput[] = []
      const nums: number[] = []
      for (const [i, tagged] of chapters.entries()) {
        const n = chapterNumberOf(tagged, i + 1)
        if (options.log !== false) {
          ctx.run.logger.info(`[translate] chapter=${n} terms=${pinned}`)
        }
        const ru = await translateTaggedChapter(tagged, {
          glossary,
          summary: slots.has('summary') ? await loadChapterSummary(options.chaptersDir, n) : '',
          entities: slots.has('ner')
            ? await loadChapterEntities(options.chaptersDir, n, ctx)
            : undefined,
          vocabulary: slots.has('vocab')
            ? await loadChapterVocabulary(options.chaptersDir, n, ctx)
            : undefined,
          priorTerms: slots.has('priorTerms') ? (options.priorTerms?.(n) ?? '') : undefined,
          chapter: n,
          titleRu: titles[i] ?? '',
          concurrency,
          terms: translateTermsEnabled(),
          memo,
          mode: options.mode,
          blockLines,
          maxTokens: options.maxTokens,
          ask: (system, user) => ask(call, system, user, ctx, options.mode, options.maxTokens),
          askRaw: (system, user) => askRawContent(call, system, user, ctx, options.maxTokens),
          onStats: (stats) => {
            if (options.log === false) return
            ctx.run.logger.info(
              `[translate] chapter=${n} lines=${stats.lines} calls=${stats.calls} fallbackLines=${stats.fallbackLines}`,
            )
          },
        })
        pairs.push({ en: stripTerms(tagged), ru })
        nums.push(n)
      }
      return setVariables(
        { ...withItem(env, pairs[0] as LineParityInput), items: pairs },
        { chapterNums: nums, titlesRu: titles },
      )
    },
  })
}
