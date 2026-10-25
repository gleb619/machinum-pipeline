import { defineTool } from '@mt/core'
import type { Envelope, Tool, ToolContext } from '@mt/core'
import type { Glossary, TermMatcher } from '../normalization/term-tagger.js'
import { compileTermMatcher } from '../normalization/term-tagger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Kind of issue found by the proofreader. */
export type ProofreadIssueKind = 'term-consistency' | 'low-cyrillic' | 'untranslated-segment'

/** One measured proofreading issue. */
export interface ProofreadIssue {
  kind: ProofreadIssueKind
  /** Human-readable description with measured numbers. */
  detail: string
  /** Surface form found in the text (term-consistency only). */
  term?: string
  /** Expected RU form from the glossary (term-consistency only). */
  expected?: string
  /** Measured share that triggered the issue (share checks only). */
  share?: number
}

/** Proofread report written to `meta.proofread`. */
export interface ProofreadReport {
  /** `true` when no issues were found. */
  ok: boolean
  /** Cyrillic letters / all letters (0..1), rounded to 6 decimals. */
  cyrillicShare: number
  /** Latin letters / all letters (0..1), rounded to 6 decimals. */
  untranslatedShare: number
  /** Measured findings. */
  issues: ProofreadIssue[]
}

export interface StatProofreadOptions {
  /** Glossary of source terms and their RU forms. */
  glossary?: Glossary
  /** Minimum share of Cyrillic letters among all letters. Default 0.3. */
  minCyrillicShare?: number
  /** Maximum share of Latin (untranslated) letters among all letters. Default 0.3. */
  maxUntranslatedShare?: number
  /** Reserved for stricter proofreading checks; currently unused. Default `false`. */
  strict?: boolean
  /**
   * `'report'` (default) = only write `meta.proofread`.
   * `'llm'` = throw a retryable {@link StatProofreadError} carrying measured feedback so an upstream LLM gate can retry.
   */
  fix?: 'report' | 'llm'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CYRILLIC = /[\u0400-\u04FF]/g
const LATIN = /[a-zA-Z]/g
const LETTER = /\p{L}/gu
const WORD_CHAR = '\\p{L}\\p{N}_'

function count(re: RegExp, s: string): number {
  return s.match(re)?.length ?? 0
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.trim() !== ''
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a matcher over source (EN) surface forms only.
 * Forms with word-boundary guards so substrings do not match.
 */
function compileSourceMatcher(glossary: Glossary): TermMatcher {
  const idOf = new Map<string, string>()
  const seen = new Set<string>()
  for (const t of glossary.terms) {
    const forms = [t.term, ...(t.aliases ?? [])].filter((f) => isNonEmptyString(f))
    for (const form of forms) {
      const surface = form.trim()
      if (surface !== '' && !seen.has(surface)) {
        seen.add(surface)
        idOf.set(surface, t.id)
      }
    }
  }
  const forms = [...idOf.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))
  if (forms.length === 0) return { regex: null, idOf }
  const body = forms
    .map((f) => {
      const first = /^[\p{L}\p{N}_]/u.test(f) ? `(?<![${WORD_CHAR}])` : ''
      const last = /[\p{L}\p{N}_]$/u.test(f) ? `(?![${WORD_CHAR}])` : ''
      return `${first}${escapeRegExp(f)}${last}`
    })
    .join('|')
  return { regex: new RegExp(body, 'gu'), idOf }
}

function getExpectedRu(glossary: Glossary, id: string): string | null {
  const term = glossary.terms.find((t) => t.id === id)
  if (!term) return null
  return isNonEmptyString(term.ru) ? term.ru.trim() : null
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Check that source-language terms appearing in the translated text have been
 * converted to their allowed RU forms from the glossary.
 *
 * A term is flagged when:
 * - its EN surface form (canonical term or alias) is found in `text`, and
 * - the glossary provides a non-empty RU form for it.
 */
export function checkTermConsistency(
  text: string,
  glossary: Glossary | undefined,
): ProofreadIssue[] {
  if (!glossary || glossary.terms.length === 0) return []
  const { regex, idOf } = compileSourceMatcher(glossary)
  if (!regex) return []
  const seen = new Map<string, ProofreadIssue>()
  for (const m of text.matchAll(regex)) {
    const surface = m[0]
    const id = idOf.get(surface)
    if (id === undefined) continue
    if (seen.has(surface)) continue
    const expected = getExpectedRu(glossary, id)
    if (expected === null) continue
    seen.set(surface, {
      kind: 'term-consistency',
      detail: `source term "${surface}" appears untranslated; expected "${expected}"`,
      term: surface,
      expected,
    })
  }
  return [...seen.values()]
}

/**
 * Check that the translated text has enough Cyrillic and not too much Latin.
 * Returns measured numbers rounded to 6 decimals.
 */
export function checkTranslatedShare(
  text: string,
  options: Pick<StatProofreadOptions, 'minCyrillicShare' | 'maxUntranslatedShare' | 'strict'> = {},
): { cyrillicShare: number; untranslatedShare: number; issues: ProofreadIssue[] } {
  const minCyrillic = options.minCyrillicShare ?? 0.3
  const maxUntranslated = options.maxUntranslatedShare ?? 0.3
  const letters = count(LETTER, text)
  const cyrillic = count(CYRILLIC, text)
  const latin = count(LATIN, text)
  const cyrillicShare = letters === 0 ? 0 : round6(cyrillic / letters)
  const untranslatedShare = letters === 0 ? 0 : round6(latin / letters)
  const issues: ProofreadIssue[] = []

  if (cyrillicShare < minCyrillic) {
    issues.push({
      kind: 'low-cyrillic',
      detail: `low-cyrillic: Cyrillic share ${cyrillicShare.toFixed(4)} below ${minCyrillic}`,
      share: cyrillicShare,
    })
  }

  if (untranslatedShare > maxUntranslated) {
    issues.push({
      kind: 'untranslated-segment',
      detail: `untranslated-segment: untranslated (Latin) share ${untranslatedShare.toFixed(4)} above ${maxUntranslated}`,
      share: untranslatedShare,
    })
  }

  return { cyrillicShare, untranslatedShare, issues }
}

/**
 * Run all offline validators and build a {@link ProofreadReport}.
 */
export function buildProofreadReport(
  text: string,
  options: StatProofreadOptions = {},
): ProofreadReport {
  const termIssues = checkTermConsistency(text, options.glossary)
  const {
    cyrillicShare,
    untranslatedShare,
    issues: shareIssues,
  } = checkTranslatedShare(text, options)
  const issues = [...termIssues, ...shareIssues]
  return { ok: issues.length === 0, cyrillicShare, untranslatedShare, issues }
}

/**
 * Measured, compact feedback for retry-prompt injection (T138 pattern).
 */
export function proofreadFeedback(report: ProofreadReport): string {
  const parts = [
    `Cyrillic share ${report.cyrillicShare}`,
    `untranslated share ${report.untranslatedShare}`,
    `${report.issues.length} issue(s)`,
  ]
  for (const issue of report.issues.slice(0, 5)) {
    parts.push(issue.detail)
  }
  return parts.join('; ')
}

/** Thrown on proofreading issues when `fix: 'llm'` is enabled; `retryable` so the engine retries. */
export class StatProofreadError extends Error {
  readonly retryable = true
  /** Measured feedback for retry-prompt injection. */
  readonly feedback: string

  constructor(readonly report: ProofreadReport) {
    const first = report.issues.slice(0, 3).map((i) => i.detail)
    super(`proofread failed (${report.issues.length} issue(s)): ${first.join('; ')}`)
    this.name = 'StatProofreadError'
    this.feedback = proofreadFeedback(report)
  }
}

// ---------------------------------------------------------------------------
// Tool factory + default instance
// ---------------------------------------------------------------------------

function cloneMeta<T>(env: Envelope<T>): Envelope<T>['meta'] {
  return { ...env.meta }
}

/**
 * Tool factory: `string` in, same string out, `meta.proofread` = {@link ProofreadReport}.
 *
 * Default mode (`fix: 'report'`) reports issues without mutating the text.
 * With `fix: 'llm'` the tool throws a retryable {@link StatProofreadError} carrying measured
 * feedback so an upstream LLM gate can self-correct.
 */
export function createStatProofread(options: StatProofreadOptions = {}): Tool<string, string> {
  return defineTool<string, string>({
    name: 'stat-proofread',
    version: '1.0.0',
    mdDescription:
      'Offline proofreader for translated text: term consistency vs a glossary and ' +
      'Cyrillic/untranslated-share checks. Report in meta.proofread; with fix: "llm" it throws ' +
      'a retryable StatProofreadError carrying measured feedback.',
    async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
      const text = env.item
      const report = buildProofreadReport(text, options)
      const meta = { ...cloneMeta(env), proofread: report }
      if (!report.ok && options.fix === 'llm') {
        throw new StatProofreadError(report)
      }
      return { item: text, meta }
    },
  })
}

/** Default proofreader: report only, no LLM retry. */
export const statProofread = createStatProofread()
