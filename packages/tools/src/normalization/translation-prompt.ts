import { z } from 'zod'
import { getDefaultPrompt, renderTemplate } from '../core/llm-prompts.js'
import { type Glossary, type GlossaryTerm, stripTerms } from './term-tagger.js'
import type { GlossaryTermType } from './term-tagger.js'

/**
 * Work mode of a translation unit:
 * - `plain` — raw translated text, 1 line in → 1 line out (default, backward compatible).
 * - `xml` — input lines wrapped as `<result><id>N</id><origin>…</origin></result>`, the model replies with
 *   `<result><id>N</id><translated>…</translated></result>` blocks.
 * - `properties` — input lines wrapped as `N=text`, the model replies with `N=translation` lines.
 */
export type TranslateWorkMode = 'plain' | 'xml' | 'properties'

export const TRANSLATE_WORK_MODES: readonly TranslateWorkMode[] = ['plain', 'xml', 'properties']

export interface TranslationPromptInput {
  /** EN text of the unit to translate; may carry `<term id="..">..</term>` tags. */
  text: string
  glossary: Glossary
  /** Chapter summary (EN). Context only, never translated. */
  summary?: string
  sourceLang?: string
  targetLang?: string
  /** Extra rules appended to the rule list (e.g. title-specific hints). */
  extraRules?: string[]
  /**
   * Work mode of the unit. Default `'plain'` (current behaviour). The bundled prompt templates
   * `translate.system` / `translate.format.<mode>` / `translate.output.<mode>` are rendered and
   * composed; the hand-built composition is kept only as a fallback when a template is missing.
   */
  mode?: TranslateWorkMode
}

export interface TranslationPrompt {
  systemPrompt: string
  /** The text to translate with `<term>` tags removed. */
  userPrompt: string
  /** Terms whose id occurs in `text` (and only those). */
  usedTerms: GlossaryTerm[]
  /** Subset of `usedTerms` without a `ru` translation yet. */
  untranslatedTerms: GlossaryTerm[]
  /**
   * Locked terms that do NOT occur in `text`; injected into the prompt anyway
   * (empty when no locked terms or all of them occur in `text`).
   */
  lockedTerms: GlossaryTerm[]
}

const TERM_ID_RE = /<term id="([^"]*)">/g
const TERMS_BLOCK_RE = /<terms>([\s\S]*?)<\/terms>/gi

/** One term reported by the model in a `<terms>` block. */
export interface ReportedTerm {
  /** English surface form as it appears in the source. */
  term: string
  /** Model-proposed translation (`null` when unsure or absent). */
  ru: string | null
  /** Model-proposed kind; `null` when absent or not a known type. */
  type: GlossaryTermType | null
}

const reportedTermSchema = z.object({
  term: z.string().min(1),
  ru: z.string().nullish(),
  type: z.enum(['character', 'place', 'item', 'skill', 'term']).nullish(),
})

function sanitizeReported(raw: unknown): ReportedTerm | null {
  const parsed = reportedTermSchema.safeParse(raw)
  if (!parsed.success) return null
  const term = parsed.data.term.trim()
  if (term === '') return null
  const ru = parsed.data.ru?.trim() ?? ''
  return { term, ru: ru === '' ? null : ru, type: parsed.data.type ?? null }
}

/**
 * Parses the `<terms>[...]</terms>` JSON block(s) of a model reply (never throws).
 * Invalid entries are dropped, duplicates are removed case-insensitively (first `ru` wins),
 * missing/empty `ru` and unknown `type` become `null`. Replies without a block yield `[]`.
 */
export function parseReportedTerms(reply: string): ReportedTerm[] {
  const blocks = [...reply.matchAll(TERMS_BLOCK_RE)].map((m) => m[1] ?? '')
  const out: ReportedTerm[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const raw of parsed) {
      const r = sanitizeReported(raw)
      if (!r) continue
      const key = r.term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

/** Ids of all `<term id="..">` tags in a text, first occurrence order, unique. */
export function termIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(TERM_ID_RE)].map((m) => m[1] as string))]
}

/**
 * `{{var}}` placeholders the bundled translate.* templates may use. {@link buildTranslationPrompt}
 * renders every block with this full var set, so a block only needs the vars it actually uses.
 */
export const TRANSLATE_TEMPLATE_VARS = [
  'sourceLang',
  'targetLang',
  'text',
  'glossaryBlock',
  'summaryBlock',
  'extraRules',
] as const

/** `{{var}}` names accepted by the translate.* templates: the builder vars plus `{{mode}}`. */
export const TRANSLATE_ALLOWED_TEMPLATE_VARS: readonly string[] = [
  ...TRANSLATE_TEMPLATE_VARS,
  'mode',
]

function translateTemplateVars(
  mode: TranslateWorkMode,
  input: TranslationPromptInput,
  from: string,
  to: string,
  glossaryBlock: string,
  summaryBlock: string,
): Record<string, string> {
  return {
    sourceLang: from,
    targetLang: to,
    text: input.text,
    glossaryBlock,
    summaryBlock,
    extraRules: (input.extraRules ?? []).map((r) => `- ${r}`).join('\n'),
    mode,
  }
}

function renderTranslateTemplate(name: string, vars: Record<string, string>): string | undefined {
  const template = getDefaultPrompt(name)?.template
  if (template === undefined) return undefined
  return renderTemplate(template, vars, name).trim()
}

/** Wraps the unit text per work mode for the user prompt. */
export function wrapTranslationInput(text: string, mode: TranslateWorkMode): string {
  if (mode === 'xml') {
    const body = text
      .split('\n')
      .map((line, i) => `<result><id>${i + 1}</id><origin>${line}</origin></result>`)
      .join('\n')
    return `<context>\n${body}\n</context>`
  }
  if (mode === 'properties') {
    const body = text
      .split('\n')
      .map((line, i) => `${i + 1}=${line}`)
      .join('\n')
    return `<context>\n${body}\n</context>`
  }
  // `plain` stays unwrapped: the reply is expected to be the translation line-by-line with no
  // framing, so any wrapper would leak into the output (and break reply echo mocks).
  return text
}

/**
 * Builds the system + user prompt for translating one unit (line/paragraph). Only the glossary
 * entries whose `<term id>` appears in the unit are injected; terms with `ru: null` are listed
 * separately with a transliterate-consistently instruction.
 *
 * Locked terms are ALWAYS injected — even when their `<term id>` does not occur in the unit —
 * so the model renders fixed translations (names, terms) exactly as decided by the human.
 *
 * The system prompt is composed from the bundled `translate.system`, `translate.format.<mode>` and
 * `translate.output.<mode>` templates (registered defaults, overridable via the prompt registry);
 * the previous hand-built composition is kept only as a fallback when a template is missing.
 */
export function buildTranslationPrompt(input: TranslationPromptInput): TranslationPrompt {
  const from = input.sourceLang ?? 'English'
  const to = input.targetLang ?? 'Russian'
  const mode = input.mode ?? 'plain'
  const byId = new Map(input.glossary.terms.map((t) => [t.id, t]))
  const usedTerms = termIdsIn(input.text)
    .map((id) => byId.get(id))
    .filter((t): t is GlossaryTerm => t !== undefined)
  const known = usedTerms.filter((t) => t.ru !== null && t.ru.trim() !== '')
  const untranslatedTerms = usedTerms.filter((t) => t.ru === null || t.ru.trim() === '')
  const usedIds = new Set(usedTerms.map((t) => t.id))
  const lockedTerms = input.glossary.terms.filter((t) => t.locked === true && !usedIds.has(t.id))
  const lockedKnown = lockedTerms.filter((t) => t.ru !== null && t.ru.trim() !== '')
  const lockedUntranslated = lockedTerms.filter((t) => t.ru === null || t.ru.trim() === '')

  const glossaryParts: string[] = []
  if (known.length > 0 || lockedKnown.length > 0) {
    glossaryParts.push(
      'Glossary (translate these terms exactly as given, never alter them):',
      ...known.map((t) => `${t.term} = ${t.ru}`),
      ...lockedKnown.map((t) => `${t.term} = ${t.ru}`),
    )
  }
  if (untranslatedTerms.length > 0 || lockedUntranslated.length > 0) {
    glossaryParts.push(
      `No ${to} translation yet for these terms: transliterate them consistently, the same way every time:`,
      ...untranslatedTerms.map((t) => t.term),
      ...lockedUntranslated.map((t) => t.term),
    )
  }
  const glossaryBlock = glossaryParts.join('\n')
  const summaryBlock = input.summary?.trim()
    ? `Chapter summary (context only, do not translate or repeat it):\n${input.summary.trim()}`
    : ''

  const vars = translateTemplateVars(mode, input, from, to, glossaryBlock, summaryBlock)
  const systemParts = [
    renderTranslateTemplate('translate.system', vars),
    renderTranslateTemplate(`translate.format.${mode}`, vars),
    renderTranslateTemplate(`translate.output.${mode}`, vars),
  ].filter((p): p is string => p !== undefined && p !== '')
  const systemPrompt =
    systemParts.length === 3
      ? systemParts.join('\n\n')
      : buildHandBuiltSystemPrompt(input, from, to)
  return {
    systemPrompt,
    userPrompt: wrapTranslationInput(stripTerms(input.text), mode),
    usedTerms,
    untranslatedTerms,
    lockedTerms,
  }
}

/** Previous hand-built system prompt; used only when a bundled translate.* template is missing. */
function buildHandBuiltSystemPrompt(
  input: TranslationPromptInput,
  from: string,
  to: string,
): string {
  const byId = new Map(input.glossary.terms.map((t) => [t.id, t]))
  const usedTerms = termIdsIn(input.text)
    .map((id) => byId.get(id))
    .filter((t): t is GlossaryTerm => t !== undefined)
  const known = usedTerms.filter((t) => t.ru !== null && t.ru.trim() !== '')
  const untranslatedTerms = usedTerms.filter((t) => t.ru === null || t.ru.trim() === '')
  const usedIds = new Set(usedTerms.map((t) => t.id))
  const lockedTerms = input.glossary.terms.filter((t) => t.locked === true && !usedIds.has(t.id))
  const lockedKnown = lockedTerms.filter((t) => t.ru !== null && t.ru.trim() !== '')
  const lockedUntranslated = lockedTerms.filter((t) => t.ru === null || t.ru.trim() === '')

  const parts = [
    `You are a professional literary translator. Translate the user text from ${from} to ${to}.`,
    'Rules:',
    '- Output exactly one translated line per input line; do not add, merge or drop lines (the single trailing <terms> block below is metadata, not a translation line).',
    '- Never split a long line into several lines: keep each input line as ONE output line.',
    '- Keep [bracketed] system messages bracketed.',
    '- Output only the translation: no notes, no quotes around it, no explanations, no <think> blocks.',
    ...(input.extraRules ?? []).map((r) => `- ${r}`),
  ]
  if (known.length > 0 || lockedKnown.length > 0) {
    parts.push(
      'Glossary (translate these terms exactly as given, never alter them):',
      ...known.map((t) => `${t.term} = ${t.ru}`),
      ...lockedKnown.map((t) => `${t.term} = ${t.ru}`),
    )
  }
  if (untranslatedTerms.length > 0 || lockedUntranslated.length > 0) {
    parts.push(
      `No ${to} translation yet for these terms: transliterate them consistently, the same way every time:`,
      ...untranslatedTerms.map((t) => t.term),
      ...lockedUntranslated.map((t) => t.term),
    )
  }
  parts.push(
    'After the translated lines, append exactly one <terms>[...]</terms> block: a JSON array of ' +
      `{"term","ru","type"} objects for English names or terms in the source that are NOT in the ` +
      `glossary above ("type" one of character|place|item|skill|term; "ru" = your translation, ` +
      'null when unsure); use [] when there is nothing to report.',
  )
  if (input.summary?.trim()) {
    parts.push(
      'Chapter summary (context only, do not translate or repeat it):',
      input.summary.trim(),
    )
  }
  return parts.join('\n')
}

/** Removes reasoning blocks, `<terms>` report blocks and `<term>` tags from a model reply. */
export function cleanTranslation(reply: string): string {
  return stripTerms(
    reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(TERMS_BLOCK_RE, ''),
  ).trim()
}

/** Joins a multi-line reply of a single-line unit into one line (models like to split long lines). */
export function joinReplyLines(reply: string): string {
  return reply
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')
}
