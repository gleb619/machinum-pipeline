import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  type Glossary,
  type GlossaryTerm,
  LLM_TYPO_FIX_PROMPT,
  LlmError,
  type RuGender,
  type SchemaDocLlmCall,
  appendMdOutput,
  compileTermMatcher,
  countTerms,
  createLlmTypoFix,
  resolveProcessLlm,
} from '@mt/tools'
import { type BookPathsOptions, type Branch, envOf, rootPathOf } from './paths.js'

/**
 * Book preprocess stage: typos, proofreading, character gender.
 *
 * The decision is data: `<chapters>/schema/quality.json` says which chapters failed the gate.
 * `MT_FORCE_BRANCH=preprocess` processes every chapter (tests, manual overrides); a
 * `translate` verdict without the override is a no-op (no LLM call, no file).
 *
 * Chapter text is cleaned with the shipped `createLlmTypoFix` tool (`chunkMode:'auto'`, its
 * line-count guard is reused as-is: a reply with a different line count is rejected and the
 * original kept). Gender normalisation is merged into the same system prompt, so a chapter
 * costs one request (one per chunk only when the chapter exceeds the model budget).
 * `chapters/clean/chapter<N>.md` receives every chapter - a byte-identical copy when the
 * chapter did not need work - so downstream always reads one directory.
 */

export const PREPROCESS_VERSION = 1

/** Variable carrying one chapter's report row (and its cleaned text) between the stages. */
export const VAR_PREPROCESS_ROW = 'preprocessRow'

/** The single log line of the no-op branch. */
export const SKIP_LOG = 'preprocess skipped verdict=translate'

/** Env var forcing the preprocess branch (mirrors the sample; overridable per entry point). */
const FORCE_BRANCH_ENV = 'MT_FORCE_BRANCH'

/** Entry-point options: project root plus the usual path/env seams. */
export interface PreprocessOptions extends BookPathsOptions {}

export interface PreprocessChapterReport {
  n: number
  llmFixed: boolean
  linesChanged: number
  digitsEqual: boolean
  calls: number
}

/** `chapters/schema/preprocess-report.json` (stable order, no timestamps). */
export interface PreprocessReport {
  version: number
  verdict: Branch
  forced: boolean
  chapters: PreprocessChapterReport[]
}

export interface PreprocessRow extends PreprocessChapterReport {
  /** Cleaned chapter (the exact bytes written to `chapters/clean/`). */
  text: string
}

export interface PreprocessPlan {
  /** Verdict read from `quality.json` (`translate` when the file is absent/unreadable). */
  verdict: Branch
  /** `MT_FORCE_BRANCH=preprocess` overrides the verdict for the whole book. */
  forced: boolean
  /** True when the stage must do nothing at all. */
  skip: boolean
  /** Chapter number -> `pass` as measured by the quality gate. */
  chapters: Map<number, boolean>
}

/**
 * Explicit preprocess backend. `call` maps to `LlmChoice.schemaCall` when the process-level
 * provider is used instead.
 */
export interface PreprocessLlm {
  call: SchemaDocLlmCall
  model?: string
}

export interface PreprocessChapterToolOptions {
  /** Resolved at invoke time so a combined phase sees the quality gate that ran earlier. */
  plan: () => PreprocessPlan
  /**
   * Explicit backend override. Precedence: this option > process-level installed provider /
   * picked backend > error. Resolved lazily at invoke time, never on the no-op branch.
   */
  llm?: () => PreprocessLlm
  /** Lazy glossary: never read when no chapter is processed. */
  glossary?: () => Glossary
}

interface QualityLike {
  verdict?: unknown
  chapters?: { n?: unknown; pass?: unknown }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the branch decision and the per-chapter verdicts from `quality.json`. */
export function readPreprocessPlan(options: PreprocessOptions): PreprocessPlan {
  const env = envOf(options)
  const forced = env[options.forceBranchEnv ?? FORCE_BRANCH_ENV]?.trim() === 'preprocess'
  const file = join(rootPathOf(options), 'schema', 'quality.json')
  const chapters = new Map<number, boolean>()
  let verdict: Branch = 'translate'

  if (existsSync(file)) {
    try {
      const artifact = JSON.parse(readFileSync(file, 'utf-8')) as QualityLike
      verdict = artifact.verdict === 'preprocess' ? 'preprocess' : 'translate'
      for (const row of artifact.chapters ?? []) {
        if (typeof row.n !== 'number' || !Number.isFinite(row.n)) continue
        chapters.set(row.n, row.pass !== false)
      }
    } catch {
      verdict = 'translate'
    }
  }

  return {
    verdict,
    forced,
    skip: (forced ? 'preprocess' : verdict) !== 'preprocess',
    chapters,
  }
}

/** A chapter is processed when it failed the gate (or the whole book is forced). */
export function chapterNeedsWork(plan: PreprocessPlan, n: number): boolean {
  if (plan.forced) return true
  return plan.chapters.get(n) !== true
}

/** Reads `glossary.json` under `root`; a missing/invalid file means "no glossary" (typos only). */
export function loadPreprocessGlossary(root: string): Glossary {
  const file = join(root, 'glossary.json')
  if (!existsSync(file)) return { terms: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (isRecord(parsed) && Array.isArray(parsed.terms)) return parsed as unknown as Glossary
  } catch {
    return { terms: [] }
  }
  return { terms: [] }
}

const GENDER_LABEL: Record<RuGender, string> = {
  m: 'male',
  f: 'female',
  n: 'neuter',
}

/**
 * Effective gender at `chapter`: the latest `genderTimeline` flip at or below the chapter,
 * else the base `ruGrammar.gender`. `undefined` when the glossary carries no gender at all.
 */
export function pinnedGender(term: GlossaryTerm, chapter: number): RuGender | undefined {
  let gender = term.ruGrammar?.gender
  for (const flip of term.genderTimeline ?? []) {
    if (flip.chapter <= chapter) gender = flip.value
  }
  return gender
}

export interface GenderPin {
  term: string
  gender: RuGender
  label: string
}

/**
 * Characters that appear in this chapter and have a pinned gender. A character without
 * `genderTimeline`/`ruGrammar.gender` is left out entirely: the text stays untouched.
 */
export function genderPins(glossary: Glossary, chapter: number, text: string): GenderPin[] {
  if (glossary.terms.length === 0) return []
  const counts = countTerms(text, glossary, compileTermMatcher(glossary))
  const pins: GenderPin[] = []
  for (const term of glossary.terms) {
    if (term.type !== 'character') continue
    if ((counts.get(term.id) ?? 0) === 0) continue
    const gender = pinnedGender(term, chapter)
    if (!gender) continue
    pins.push({ term: term.term, gender, label: GENDER_LABEL[gender] })
  }
  return pins.sort((left, right) => (left.term < right.term ? -1 : left.term > right.term ? 1 : 0))
}

/**
 * The merged system prompt: the shipped typo/proofreading prompt, plus a gender block only
 * when this chapter has at least one pinned character. One prompt per chapter, one request.
 */
export function preprocessSystemPrompt(pins: readonly GenderPin[]): string {
  if (pins.length === 0) return LLM_TYPO_FIX_PROMPT
  return [
    LLM_TYPO_FIX_PROMPT,
    '',
    'Gender normalisation (same pass, keep the line count unchanged):',
    'Keep every pronoun and gendered reference of these characters consistent with the pinned gender:',
    ...pins.map((pin) => `- ${pin.term}: ${pin.label} (${pin.gender})`),
    'Do not change the story, add sentences, or touch any other character.',
  ].join('\n')
}

/** Digits of the text as a sorted multiset string (R2: chunking must not eat numerals). */
export function digitMultiset(text: string): string {
  return (text.match(/\d/g) ?? []).sort().join('')
}

/** Number of differing lines; 0 when the reply was rejected (line counts differ). */
function countChangedLines(before: string, after: string): number {
  const left = before.split('\n')
  const right = after.split('\n')
  if (left.length !== right.length) return 0
  let changed = 0
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) changed += 1
  }
  return changed
}

export interface PreprocessTextOptions {
  n: number
  markdown: string
  call: SchemaDocLlmCall
  model?: string
  glossary?: Glossary
  ctx?: ToolContext
}

/**
 * Cleans one chapter through {@link createLlmTypoFix}. The tool's line-count guard decides
 * application: a rejected reply leaves `llmFixed:false` and the original text in place.
 * Trailing whitespace is normalised only so the guard compares the same text it receives;
 * the original line ending is restored on output (line count is always preserved).
 */
export async function preprocessText(options: PreprocessTextOptions): Promise<PreprocessRow> {
  const source = options.markdown.trimEnd()
  const pins = genderPins(options.glossary ?? { terms: [] }, options.n, source)
  const counter = { calls: 0 }
  const typoFix = createLlmTypoFix({
    call: (input, ctx) => {
      counter.calls += 1
      return options.call(input, ctx)
    },
    ...(options.model ? { model: options.model } : {}),
    chunkMode: 'auto',
    systemPrompt: preprocessSystemPrompt(pins),
  })

  const out = await typoFix.invoke(createExchange(source), options.ctx ?? ({} as ToolContext))
  const llmFixed = getVariable<boolean>(out, 'llmFixed') === true
  const fixed = out.item.trimEnd()
  const eol = options.markdown.endsWith('\n') ? '\n' : ''

  return {
    n: options.n,
    text: `${fixed}${eol}`,
    llmFixed,
    linesChanged: countChangedLines(source, fixed),
    digitsEqual: digitMultiset(source) === digitMultiset(fixed),
    calls: counter.calls,
  }
}

/** Deterministic report bytes: chapters ascending, fields in a fixed order, no timestamps. */
export function serializePreprocessReport(report: PreprocessReport): string {
  const chapters = [...report.chapters]
    .sort((left, right) => left.n - right.n)
    .map((chapter) => ({
      n: chapter.n,
      llmFixed: chapter.llmFixed,
      linesChanged: chapter.linesChanged,
      digitsEqual: chapter.digitsEqual,
      calls: chapter.calls,
    }))
  return `${JSON.stringify(
    {
      version: report.version,
      verdict: report.verdict,
      forced: report.forced,
      chapters,
    },
    null,
    2,
  )}\n`
}

function passThrough(env: Exchange<string>, n: number): Exchange<string> {
  return setVariable(env, VAR_PREPROCESS_ROW, {
    n,
    text: env.item,
    llmFixed: false,
    linesChanged: 0,
    digitsEqual: true,
    calls: 0,
  } satisfies PreprocessRow)
}

/** Per-chapter stage: copy the chapter, or run the merged typo/gender pass when it failed. */
export function createPreprocessChapterTool(options: PreprocessChapterToolOptions) {
  return defineTool<string, string>({
    name: 'preprocess-chapter',
    version: '1.0.0',
    description:
      'Cleans one failed chapter with the merged typo/proofread/gender prompt; copies a passing chapter byte-identically.',
    annotations: [
      tool('TL276', {
        name: 'preprocess-chapter',
        description: 'Cleans one failed chapter with the merged typo/proofread/gender prompt.',
        refs: ['UC058'],
      }),
      category(['normalizer']),
    ],
    async invoke(env, ctx) {
      const n = Number(env.meta.chapterNum ?? 0)
      if (!chapterNeedsWork(options.plan(), n)) return passThrough(env, n)
      const llm = options.llm?.() ?? resolveProcessLlm()
      if (!llm) {
        throw new LlmError(
          'preprocess-chapter: no LLM backend available; pass options.llm or install/configure a process-level LLM provider',
        )
      }
      const row = await preprocessText({
        n,
        markdown: env.item,
        call: 'call' in llm ? llm.call : llm.schemaCall,
        ...(llm.model ? { model: llm.model } : {}),
        glossary: options.glossary?.() ?? { terms: [] },
        ctx,
      })
      return setVariable(env, VAR_PREPROCESS_ROW, row)
    },
  })
}

/** Per-chapter stage (outside the batch scope): writes this member's clean chapter file. */
export function createEmitCleanChapter() {
  return defineTool<unknown, unknown>({
    name: 'emit-clean-chapter',
    version: '1.0.0',
    description: 'Writes the cleaned text of one chapter to chapters/clean/chapter<N>.md.',
    annotations: [
      tool('TL277', {
        name: 'emit-clean-chapter',
        description: 'Writes one cleaned chapter to chapters/clean/.',
        refs: ['UC058'],
      }),
      category(['serializer']),
    ],
    async invoke(env) {
      const row = getVariable<PreprocessRow>(env, VAR_PREPROCESS_ROW)
      if (!row) return env
      return appendMdOutput(env, {
        name: 'clean-chapter',
        subdir: 'clean',
        filename: `chapter${row.n}.md`,
        content: row.text,
      })
    },
  })
}

/** Aggregation stage: writes `chapters/schema/preprocess-report.json` from the batch rows. */
export function createWritePreprocessReport(plan: () => PreprocessPlan) {
  return defineTool<unknown, unknown>({
    name: 'write-preprocess-report',
    version: '1.0.0',
    description: 'Writes schema/preprocess-report.json from the measured chapter rows.',
    annotations: [
      tool('TL278', {
        name: 'write-preprocess-report',
        description: 'Emits the deterministic preprocess report for every chapter.',
        refs: ['UC058'],
      }),
      category(['analyzer']),
    ],
    async invoke(env, ctx) {
      const members = batchMembersOf<unknown>(env) ?? []
      const rows = members
        .map((member) => getVariable<PreprocessRow>(member, VAR_PREPROCESS_ROW))
        .filter((row): row is PreprocessRow => row !== undefined)
        .sort((left, right) => left.n - right.n)

      const processed = rows.filter((row) => row.calls > 0).length
      const calls = rows.reduce((sum, row) => sum + row.calls, 0)
      const fixed = rows.filter((row) => row.llmFixed).length
      ctx.run.logger.info(
        `preprocess chapters=${rows.length} processed=${processed} calls=${calls} llmFixed=${fixed}`,
      )

      return appendMdOutput(env, {
        name: 'preprocess-report',
        subdir: 'schema',
        filename: 'preprocess-report.json',
        content: serializePreprocessReport({
          version: PREPROCESS_VERSION,
          verdict: plan().verdict,
          forced: plan().forced,
          chapters: rows,
        }),
      })
    },
  })
}
