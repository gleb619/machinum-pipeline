import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type Exchange,
  type ToolContext,
  batchMembersOf,
  createExchange,
  defineTool,
  getVariable,
  setVariable,
} from '@mt/core'
import {
  appendMdOutput,
  chapterValidator,
  countTextTokens,
  forbiddenCharDetector,
  typoFinder,
} from '@mt/tools'
import { chapterBody } from './stats.js'

/**
 * Stage 5 of the book flow: the quality gate behind the translate/preprocess branch.
 *
 * The DSL has no conditional branch (`fork` runs every child), so the decision is data:
 * this stage writes `chapters/schema/quality.json` and `lib/input.ts bookSource()` reads it.
 * Every signal is offline and runs on the English source; no LLM is resolved or called.
 */

export const ROOT = resolve(import.meta.dirname, '..')

/** The real book of this sample (same URI as `lib/input.ts BOOK2`). */
export const BOOK2_URI = 'md://../../books/book2'

/** Test seam: output root (default `@chapters`), also read for `schema/stats.json` + map. */
export const ROOT_ENV = 'MT_QUALITY_ROOT'
/** Test seam: source book directory URI (default: split dir, else `books/book2`). */
export const BOOK_ENV = 'MT_QUALITY_BOOK'

/** Thresholds of the gate. Percent values are 0..100, ratios are tokens per word. */
export const THRESHOLDS = {
  typosPer1k: 5,
  foreignPct: 0.5,
  quotePct: 2,
  tokPerWordMin: 1.1,
  tokPerWordMax: 2,
  passRate: 0.9,
} as const

export interface QualityThresholds {
  typosPer1k: number
  foreignPct: number
  quotePct: number
  tokPerWordMin: number
  tokPerWordMax: number
  passRate: number
}

/** A failed signal, in canonical order (stable output and stable `reasons[]`). */
export type QualityReason =
  | 'typos'
  | 'forbidden'
  | 'structure'
  | 'leaks'
  | 'foreign'
  | 'quotes'
  | 'tokens'

const REASON_ORDER: readonly QualityReason[] = [
  'typos',
  'forbidden',
  'structure',
  'leaks',
  'foreign',
  'quotes',
  'tokens',
]

/** A hard signal: any chapter tripping one forces the preprocess branch. */
const HARD_REASONS: readonly QualityReason[] = ['forbidden', 'structure', 'leaks']

export interface ChapterSignals {
  per1kTypos: number
  forbidden: number
  structure: number
  leaks: number
  foreignPct: number
  quotePct: number
  tokPerWord: number
  pass: boolean
  reasons: QualityReason[]
}

export interface ChapterQuality extends ChapterSignals {
  n: number
}

export interface QualitySummary {
  passRate: number
  hard: number[]
}

/** `chapters/schema/quality.json` (stable key order, no timestamps). */
export interface QualityArtifact {
  version: number
  verdict: 'translate' | 'preprocess'
  source: string
  thresholds: QualityThresholds
  summary: QualitySummary
  chapters: ChapterQuality[]
}

/** Variable carrying one chapter's measured row between the two glue stages. */
export const VAR_CHAPTER_QUALITY = 'chapterQuality'

const VERSION = 1
const CTX = {} as ToolContext

/** Round to two decimals so a rerun serializes byte-identically. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function wordsOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// ---------------------------------------------------------------------------
// Filesystem seams
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  '@chapters': join(ROOT, 'chapters'),
  '@schema': join(ROOT, 'chapters', 'schema'),
  '@book2': resolve(ROOT, '../../books/book2'),
}

/** Filesystem path of a project URI (`@alias`, `md://` relative or an absolute path). */
export function uriPath(uri: string): string {
  const raw = uri.replace(/^md:\/\//, '').trim()
  const alias = ALIASES[raw]
  if (alias) return alias
  return isAbsolute(raw) ? raw : resolve(ROOT, raw)
}

export function qualityRootUri(): string {
  return process.env[ROOT_ENV]?.trim() || '@chapters'
}

export function qualityRootPath(): string {
  return uriPath(qualityRootUri())
}

interface ChapterMapLike {
  [id: string]: { orig: number; part: number; of: number }
}

function readChapterMap(root = qualityRootPath()): ChapterMapLike | undefined {
  const file = join(root, 'schema', 'chapter-map.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ChapterMapLike
  } catch {
    return undefined
  }
}

/** True when the split stage wrote renumbered parts (any source chapter became >1 part). */
export function splitProduced(root = qualityRootPath()): boolean {
  const map = readChapterMap(root)
  if (!map) return false
  return Object.values(map).some((entry) => entry.of > 1)
}

/** Split directory URI for an output root: `@chapters` -> `md://./chapters/split`. */
export function splitUriFor(rootUri = qualityRootUri()): string {
  if (rootUri === '@chapters') return 'md://./chapters/split'
  if (rootUri.startsWith('md://')) return `${rootUri.replace(/\/$/, '')}/split`
  return `md://${join(uriPath(rootUri), 'split')}`
}

/** The analysed source: explicit override, else the split output when it exists, else book2. */
export function qualitySourceUri(): string {
  const override = process.env[BOOK_ENV]?.trim()
  if (override) return override
  return splitProduced() ? splitUriFor() : BOOK2_URI
}

interface StatsLike {
  chapters: { n: number; ratioToMean: number }[]
}

/**
 * `stats.json` ratios. A size outlier is strictly informational: it is measured and exposed to
 * {@link buildQuality} but never turns into a fail reason (a long chapter is not a bad one).
 */
export function readRatioToMean(root = qualityRootPath()): Map<number, number> {
  const file = join(root, 'schema', 'stats.json')
  if (!existsSync(file)) {
    throw new Error(`quality: ${file} missing — run runner:stats first`)
  }
  const stats = JSON.parse(readFileSync(file, 'utf-8')) as StatsLike
  return new Map(stats.chapters.map((chapter) => [chapter.n, chapter.ratioToMean]))
}

// ---------------------------------------------------------------------------
// Proper nouns (glossary / NER names and aliases are not typos)
// ---------------------------------------------------------------------------

export interface ProperNounSources {
  entities?: string
  glossary?: string
  names?: string
}

function defaultProperNounSources(root = qualityRootPath()): ProperNounSources {
  return {
    entities: join(root, 'schema', 'entities.json'),
    glossary: join(ROOT, 'chapters', 'glossary.json'),
    names: join(ROOT, 'chapters', 'names.json'),
  }
}

function readJson(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lower-case name surface plus its possessive base and capitalised tokens. A proper noun is not
 * a typo; tokens are only added from the name itself (`Kestrel Point` -> `kestrel`, `point`).
 */
function addName(target: Set<string>, name: string): void {
  const surface = name.trim().toLowerCase()
  if (surface === '') return
  target.add(surface)
  target.add(surface.replace(/['’]s$/, ''))
  for (const token of name.trim().split(/\s+/)) {
    if (token.length < 3) continue
    if (!/^\p{Lu}/u.test(token)) continue
    target.add(token.toLowerCase())
  }
}

/** Every proper noun the corpus knows about: NER entities, glossary terms, editorial names. */
export function collectProperNouns(
  sources: ProperNounSources = defaultProperNounSources(),
): Set<string> {
  const names = new Set<string>()

  const entities = readJson(sources.entities)
  if (isRecord(entities) && Array.isArray(entities.entities)) {
    for (const entity of entities.entities) {
      if (!isRecord(entity)) continue
      if (typeof entity.name === 'string') addName(names, entity.name)
      if (Array.isArray(entity.aliases)) {
        for (const alias of entity.aliases) if (typeof alias === 'string') addName(names, alias)
      }
    }
  }

  const glossary = readJson(sources.glossary)
  if (isRecord(glossary) && Array.isArray(glossary.terms)) {
    for (const term of glossary.terms) {
      if (!isRecord(term)) continue
      if (typeof term.term === 'string') addName(names, term.term)
      if (Array.isArray(term.aliases)) {
        for (const alias of term.aliases) if (typeof alias === 'string') addName(names, alias)
      }
    }
  }

  const editorial = readJson(sources.names)
  if (isRecord(editorial)) {
    for (const group of Object.values(editorial)) {
      if (!isRecord(group)) continue
      for (const name of Object.keys(group)) addName(names, name)
    }
  }

  return names
}

let cachedNames: Set<string> | undefined

function properNouns(): Set<string> {
  cachedNames ??= collectProperNouns()
  return cachedNames
}

export function isProperNoun(word: string, names: ReadonlySet<string>): boolean {
  const surface = word
    .toLowerCase()
    .replace(/['’]s$/, '')
    .replace(/^[^\p{L}]+|[^\p{L}']+$/gu, '')
  return surface !== '' && names.has(surface)
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface CspellIssue {
  text?: string
  suggestions?: string[]
  issueType?: number
}

interface CspellModule {
  spellCheckDocument: (
    document: { uri: string; text: string; languageId: string; locale: string },
    options: { generateSuggestions: boolean },
    settings: { suggestionsTimeout: number },
  ) => Promise<{ issues: CspellIssue[] }>
}

/**
 * `typoFinder` filters on `issueType === 0`, but cspell-lib 8.19 only sets `issueType` on
 * directive issues, so the tool always returns no issues here. The fallback imports the same
 * cspell-lib instance `@mt/tools` uses (no new dependency) and applies the identical
 * "spelling issue with a suggestion" rule, so the signal still measures the real text.
 */
async function cspellModule(): Promise<CspellModule | null> {
  try {
    const nodeModule = (await import('node:module')) as {
      findPackageJSON?: (specifier: string, base: string | URL) => string | undefined
    }
    const toolsPackage = join(ROOT, '../../packages/tools/package.json')
    const found = nodeModule.findPackageJSON?.('cspell-lib', pathToFileURL(toolsPackage))
    const pkgPath = found ?? join(ROOT, '../../packages/tools/node_modules/cspell-lib/package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      exports?: Record<string, { import?: string }>
      module?: string
      main?: string
    }
    const entry = pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main
    if (!entry) return null
    const mod = (await import(
      pathToFileURL(join(dirname(pkgPath), entry)).href
    )) as Partial<CspellModule>
    return typeof mod.spellCheckDocument === 'function' ? (mod as CspellModule) : null
  } catch {
    return null
  }
}

let cspellPromise: Promise<CspellModule | null> | undefined

function spellCheck(text: string): Promise<CspellIssue[]> {
  cspellPromise ??= cspellModule()
  return cspellPromise.then(async (cspell) => {
    if (!cspell) return []
    const result = await cspell.spellCheckDocument(
      { uri: 'input.txt', text, languageId: 'plaintext', locale: 'en' },
      { generateSuggestions: true },
      { suggestionsTimeout: 2000 },
    )
    return result.issues.filter(
      (issue) =>
        issue.text &&
        issue.suggestions?.length &&
        (issue.issueType === undefined || issue.issueType === 0),
    )
  })
}

/** Typo issues as plain words: the tool first, the same engine when the tool reports none. */
export async function findTypos(text: string): Promise<string[]> {
  const tool = await typoFinder.invoke(createExchange({ text }), CTX)
  if (tool.item.issues.length > 0) {
    return tool.item.issues
      .map((issue) => /`([^`]+)`/.exec(issue.text)?.[1])
      .filter((word): word is string => typeof word === 'string')
  }
  const issues = await spellCheck(text)
  return issues.map((issue) => issue.text as string)
}

const LEAK_LINE = /^(?:TL;DR|Translator'?s? note|Source:|https?:\/\/)/i
const LEAK_TAG = /<[a-z]+>/
const LEAK_CITATION = /\[\d+\]/

/** Lines carrying metadata, translator notes, URLs or HTML-ish markup. */
export function leakLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return LEAK_LINE.test(trimmed) || LEAK_TAG.test(line) || LEAK_CITATION.test(line)
  }).length
}

/** Non-Latin letters / all letters, in percent (0 when the text has no letters). */
export function foreignScriptPct(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) return 0
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0
  return ((letters - latin) / letters) * 100
}

/**
 * A paragraph is flawed when its curly quotes do not pair, its straight quotes are odd, or a
 * line starts with a lone closing quote (a broken dialogue continuation).
 */
export function flawedQuoteParagraph(paragraph: string): boolean {
  if ((paragraph.match(/“/g)?.length ?? 0) !== (paragraph.match(/”/g)?.length ?? 0)) return true
  if ((paragraph.match(/"/g)?.length ?? 0) % 2 === 1) return true
  return paragraph.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('”')) return true
    return trimmed.startsWith('"') && (trimmed.match(/"/g)?.length ?? 0) === 1
  })
}

/** Share of flawed paragraphs, in percent. */
export function quotePct(text: string): number {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) return 0
  const flawed = paragraphs.filter(flawedQuoteParagraph).length
  return (flawed / paragraphs.length) * 100
}

async function structureErrors(text: string): Promise<number> {
  const out = await chapterValidator.invoke(createExchange(text), CTX)
  if (getVariable<boolean>(out, 'valid') !== false) return 0
  return getVariable<string[]>(out, 'errors')?.length ?? 1
}

/** One-offline-pass signals for one chapter on the English source. */
export async function analyzeChapter(
  text: string,
  names: ReadonlySet<string> = properNouns(),
): Promise<ChapterSignals> {
  const body = chapterBody(text)
  const words = wordsOf(body)

  const typoWords = (await findTypos(text)).filter((word) => !isProperNoun(word, names))
  const per1kTyposRaw = words > 0 ? (typoWords.length / words) * 1000 : 0

  const forbiddenOut = await forbiddenCharDetector.invoke(createExchange(text), CTX)
  const forbidden = getVariable<unknown[]>(forbiddenOut, 'forbidden')?.length ?? 0

  const structure = await structureErrors(text)
  const leaks = leakLines(text)
  const foreignRaw = foreignScriptPct(text)
  const quoteRaw = quotePct(text)
  const tokPerWordRaw = words > 0 ? countTextTokens(body) / words : 0

  const reasons: QualityReason[] = []
  if (per1kTyposRaw > THRESHOLDS.typosPer1k) reasons.push('typos')
  if (forbidden > 0) reasons.push('forbidden')
  if (structure > 0) reasons.push('structure')
  if (leaks > 0) reasons.push('leaks')
  if (foreignRaw > THRESHOLDS.foreignPct) reasons.push('foreign')
  if (quoteRaw > THRESHOLDS.quotePct) reasons.push('quotes')
  if (tokPerWordRaw < THRESHOLDS.tokPerWordMin || tokPerWordRaw > THRESHOLDS.tokPerWordMax) {
    reasons.push('tokens')
  }
  reasons.sort((left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right))

  return {
    per1kTypos: round2(per1kTyposRaw),
    forbidden,
    structure,
    leaks,
    foreignPct: round2(foreignRaw),
    quotePct: round2(quoteRaw),
    tokPerWord: round2(tokPerWordRaw),
    pass: reasons.length === 0,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface BuildQualityInput {
  chapters: readonly ChapterQuality[]
  source: string
  /** Informational only: an outlier is measured, never a fail reason. */
  ratioToMean?: ReadonlyMap<number, number>
}

/**
 * Deterministic artifact from the measured rows; chapter order is ascending `n`.
 *
 * `input.ratioToMean` is read (and stats.json is therefore a hard prerequisite) but deliberately
 * never reaches `pass`/`reasons`: a chapter larger than 1.5x the mean is informational, not bad.
 */
export function buildQuality(input: BuildQualityInput): QualityArtifact {
  const chapters = [...input.chapters].sort((left, right) => left.n - right.n)
  const hard = chapters
    .filter((chapter) => chapter.reasons.some((reason) => HARD_REASONS.includes(reason)))
    .map((chapter) => chapter.n)
  const passing = chapters.filter((chapter) => chapter.pass).length
  const passRate = chapters.length > 0 ? passing / chapters.length : 0
  const verdict = passRate >= THRESHOLDS.passRate && hard.length === 0 ? 'translate' : 'preprocess'

  return {
    version: VERSION,
    verdict,
    source: input.source,
    thresholds: { ...THRESHOLDS },
    summary: { passRate: round2(passRate), hard },
    chapters,
  }
}

/**
 * JSON in the repo formatter's shape: Biome keeps short arrays inline (the same reason
 * `lib/ner.ts` has a custom `numberArray`). Long `chapters`/`reasons` stay one value per line.
 */
export function compactArrays(json: string): string {
  return json.replace(/\[\n([^[\]]*?)\n(\s*)\]/g, (match, body: string, indent: string) => {
    const values = body
      .split(/,\n/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
    const inline = `[${values.join(', ')}]`
    return indent.length + inline.length <= 100 ? inline : match
  })
}

export function serializeQuality(artifact: QualityArtifact): string {
  return `${compactArrays(JSON.stringify(artifact, null, 2))}\n`
}

/** Stage A: measure one batch member and stash its row on the envelope. */
export const collectChapterQuality = defineTool<string, string>({
  name: 'collect-chapter-quality',
  version: '1.0.0',
  description: 'Measures the offline quality signals of one chapter.',
  async invoke(env: Exchange<string>) {
    const n = Number(env.meta.chapterNum ?? 0)
    const signals = await analyzeChapter(env.item)
    return setVariable(env, VAR_CHAPTER_QUALITY, { n, ...signals } satisfies ChapterQuality)
  },
})

/** Stage B: aggregate the rows, log the verdict and emit `schema/quality.json`. */
export const writeQuality = defineTool<unknown, unknown>({
  name: 'write-quality',
  version: '1.0.0',
  description:
    'Emits schema/quality.json from the measured chapter rows and logs the translate/preprocess verdict.',
  async invoke(env, ctx) {
    const members = batchMembersOf<unknown>(env) ?? []
    const chapters = members
      .map((member) => getVariable<ChapterQuality>(member, VAR_CHAPTER_QUALITY))
      .filter((chapter): chapter is ChapterQuality => chapter !== undefined)
    const artifact = buildQuality({
      chapters,
      source: qualitySourceUri(),
      ratioToMean: readRatioToMean(),
    })
    ctx.run.logger.info(
      `quality verdict=${artifact.verdict} passRate=${artifact.summary.passRate} hard=${artifact.summary.hard.length}`,
    )
    return appendMdOutput(env, {
      name: 'quality',
      subdir: 'schema',
      filename: 'quality.json',
      content: serializeQuality(artifact),
    })
  },
})
