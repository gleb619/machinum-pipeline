import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type Exchange,
  type ToolContext,
  batchMembersOf,
  category,
  createExchange,
  defineTool,
  getVariable,
  setVariable,
  tool,
} from '@mt/core'
import {
  appendMdOutput,
  chapterValidator,
  countTextTokens,
  forbiddenCharDetector,
  typoFinder,
} from '@mt/tools'
import { compactArrays } from './json.js'
import { DEFAULT_BOOK_ENV, bookUriOf, chaptersDirOf, envOf, uriPath } from './paths.js'
import { type SplitPathsOptions, splitProduced, splitRootUri, splitUriFor } from './split.js'
import { chapterBody } from './stats.js'

/**
 * Offline quality gate behind the translate/preprocess branch.
 *
 * The DSL has no conditional branch (`fork` runs every child), so the decision is data:
 * this stage writes `schema/quality.json` and the consumer reads it (`createBookSource` in
 * `input.ts`). Every signal is offline and runs on the English source; no LLM is resolved or
 * called.
 *
 * The package never guesses a project root: every filesystem entry point takes
 * {@link QualityOptions} and resolves paths through `./paths.js` and `./split.js`.
 */

export { compactArrays } from './json.js'

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

/** `schema/quality.json` (stable key order, no timestamps). */
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

function thresholdsOf(overrides?: Partial<QualityThresholds>): QualityThresholds {
  return { ...THRESHOLDS, ...overrides }
}

// ---------------------------------------------------------------------------
// Filesystem seams
// ---------------------------------------------------------------------------

export interface QualityOptions extends SplitPathsOptions {}

/** Output root URI of the quality stage: the split root, so both artefacts share one tree. */
export function qualityRootUri(options: QualityOptions): string {
  return splitRootUri(options)
}

/** Filesystem path of {@link qualityRootUri}. */
export function qualityRootPath(options: QualityOptions): string {
  return uriPath(qualityRootUri(options), options)
}

/** The analysed source: explicit book override, else the split output, else the book URI. */
export function qualitySourceUri(options: QualityOptions): string {
  const override = envOf(options)[options.bookEnv ?? DEFAULT_BOOK_ENV]?.trim()
  if (override) return override
  return splitProduced(options) ? splitUriFor(options) : bookUriOf(options)
}

interface StatsLike {
  chapters: { n: number; ratioToMean: number }[]
}

/**
 * `stats.json` ratios. A size outlier is strictly informational: it is measured and exposed to
 * {@link buildQuality} but never turns into a fail reason (a long chapter is not a bad one).
 */
export function readRatioToMean(options: QualityOptions): Map<number, number> {
  const file = join(qualityRootPath(options), 'schema', 'stats.json')
  if (!existsSync(file)) {
    throw new Error(`quality: ${file} missing — run the stats stage first`)
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

/** Default corpus sources under one project: NER entities, glossary terms, editorial names. */
export function properNounSourcesOf(options: QualityOptions): ProperNounSources {
  return {
    entities: join(qualityRootPath(options), 'schema', 'entities.json'),
    glossary: join(chaptersDirOf(options), 'glossary.json'),
    names: join(chaptersDirOf(options), 'names.json'),
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
export function collectProperNouns(sources: ProperNounSources = {}): Set<string> {
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

/** Find `node_modules/cspell-lib` by walking up from the `@mt/tools` package root. */
function findCspellPackage(toolsRoot: string): string | undefined {
  let dir = toolsRoot
  for (;;) {
    const candidate = join(dir, 'node_modules', 'cspell-lib', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * `typoFinder` filters on `issueType === 0`, but cspell-lib 8.19 only sets `issueType` on
 * directive issues, so the tool always returns no issues here. The fallback imports the same
 * cspell-lib instance `@mt/tools` uses (no new dependency) and applies the identical
 * "spelling issue with a suggestion" rule, so the signal still measures the real text.
 */
async function cspellModule(): Promise<CspellModule | null> {
  try {
    const toolsEntry = import.meta.resolve('@mt/tools')
    const toolsRoot = dirname(dirname(fileURLToPath(toolsEntry)))
    const pkgPath = findCspellPackage(toolsRoot)
    if (!pkgPath) return null
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
  const result = await typoFinder.invoke(createExchange({ text }), CTX)
  if (result.item.issues.length > 0) {
    return result.item.issues
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

function reasonsOf(
  signals: ChapterSignals,
  thresholds: QualityThresholds = THRESHOLDS,
): QualityReason[] {
  const reasons: QualityReason[] = []
  if (signals.per1kTypos > thresholds.typosPer1k) reasons.push('typos')
  if (signals.forbidden > 0) reasons.push('forbidden')
  if (signals.structure > 0) reasons.push('structure')
  if (signals.leaks > 0) reasons.push('leaks')
  if (signals.foreignPct > thresholds.foreignPct) reasons.push('foreign')
  if (signals.quotePct > thresholds.quotePct) reasons.push('quotes')
  if (
    signals.tokPerWord < thresholds.tokPerWordMin ||
    signals.tokPerWord > thresholds.tokPerWordMax
  ) {
    reasons.push('tokens')
  }
  return reasons.sort((left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right))
}

/** One offline pass of signals for one chapter on the English source. */
export async function analyzeChapter(
  text: string,
  names: ReadonlySet<string> = new Set<string>(),
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

  const signals = {
    per1kTypos: round2(per1kTyposRaw),
    forbidden,
    structure,
    leaks,
    foreignPct: round2(foreignRaw),
    quotePct: round2(quoteRaw),
    tokPerWord: round2(tokPerWordRaw),
  }
  const reasons = reasonsOf({ ...signals, pass: false, reasons: [] })

  return { ...signals, pass: reasons.length === 0, reasons }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface BuildQualityInput {
  chapters: readonly ChapterQuality[]
  source: string
  /** Informational only: an outlier is measured, never a fail reason. */
  ratioToMean?: ReadonlyMap<number, number>
  /** Overrides for the recorded thresholds; reasons are recomputed from the signals. */
  thresholds?: Partial<QualityThresholds>
}

function withThresholds(chapter: ChapterQuality, thresholds: QualityThresholds): ChapterQuality {
  const reasons = reasonsOf(chapter, thresholds)
  return { ...chapter, pass: reasons.length === 0, reasons }
}

/**
 * Deterministic artifact from the measured rows; chapter order is ascending `n`.
 *
 * `input.ratioToMean` is read (and stats.json is therefore a hard prerequisite for the write
 * tool) but deliberately never reaches `pass`/`reasons`: a chapter larger than 1.5x the mean is
 * informational, not bad.
 */
export function buildQuality(input: BuildQualityInput): QualityArtifact {
  const thresholds = thresholdsOf(input.thresholds)
  const chapters = [...input.chapters]
    .sort((left, right) => left.n - right.n)
    .map((chapter) => withThresholds(chapter, thresholds))
  const hard = chapters
    .filter((chapter) => chapter.reasons.some((reason) => HARD_REASONS.includes(reason)))
    .map((chapter) => chapter.n)
  const passing = chapters.filter((chapter) => chapter.pass).length
  const passRate = chapters.length > 0 ? passing / chapters.length : 0
  const verdict = passRate >= thresholds.passRate && hard.length === 0 ? 'translate' : 'preprocess'

  return {
    version: VERSION,
    verdict,
    source: input.source,
    thresholds,
    summary: { passRate: round2(passRate), hard },
    chapters,
  }
}

/**
 * JSON in the repo formatter's shape: Biome keeps short arrays inline. Long `chapters`/`reasons`
 * stay one value per line.
 */
export function serializeQuality(artifact: QualityArtifact): string {
  return `${compactArrays(JSON.stringify(artifact, null, 2))}\n`
}

/** Stage A: measure one batch member and stash its row on the envelope. */
export function createCollectChapterQuality(options: { names?: () => ReadonlySet<string> } = {}) {
  return defineTool<string, string>({
    name: 'collect-chapter-quality',
    version: '1.0.0',
    description: 'Measures the offline quality signals of one chapter.',
    annotations: [
      tool('TL266', {
        name: 'collect-chapter-quality',
        description: 'Measures one chapter’s offline quality signals.',
        refs: ['UC057'],
      }),
      category(['validator']),
    ],
    async invoke(env: Exchange<string>) {
      const n = Number(env.meta.chapterNum ?? 0)
      const names = options.names?.()
      const signals = await analyzeChapter(env.item, names)
      return setVariable(env, VAR_CHAPTER_QUALITY, { n, ...signals } satisfies ChapterQuality)
    },
  })
}

/** Stage A with no project-specific proper-noun corpus. */
export const collectChapterQuality = createCollectChapterQuality()

export interface WriteQualityToolOptions {
  /** Analysed source URI recorded in the artefact. */
  source: () => string
  /** `stats.json` ratios; read lazily so the stats stage may run first. */
  ratioToMean: () => Map<number, number>
  /** Overrides for the recorded thresholds; reasons are recomputed from the signals. */
  thresholds?: Partial<QualityThresholds>
}

/** Stage B: aggregate the rows, log the verdict and emit `schema/quality.json`. */
export function createWriteQualityTool(options: WriteQualityToolOptions) {
  return defineTool<unknown, unknown>({
    name: 'write-quality',
    version: '1.0.0',
    description:
      'Emits schema/quality.json from the measured chapter rows and logs the translate/preprocess verdict.',
    annotations: [
      tool('TL267', {
        name: 'write-quality',
        description: 'Aggregates chapter quality rows and records the branch verdict.',
        refs: ['UC057'],
      }),
      category(['analyzer']),
    ],
    async invoke(env, ctx) {
      const members = batchMembersOf<unknown>(env) ?? []
      const chapters = members
        .map((member) => getVariable<ChapterQuality>(member, VAR_CHAPTER_QUALITY))
        .filter((chapter): chapter is ChapterQuality => chapter !== undefined)
      const artifact = buildQuality({
        chapters,
        source: options.source(),
        ratioToMean: options.ratioToMean(),
        thresholds: options.thresholds,
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
}
