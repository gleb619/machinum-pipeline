import { z } from 'zod'
import { type Glossary, type GlossaryTerm, stripTerms } from './term-tagger.js'
import type { GlossaryTermType } from './term-tagger.js'

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
}

export interface TranslationPrompt {
  systemPrompt: string
  /** The text to translate with `<term>` tags removed. */
  userPrompt: string
  /** Terms whose id occurs in `text` (and only those). */
  usedTerms: GlossaryTerm[]
  /** Subset of `usedTerms` without a `ru` translation yet. */
  untranslatedTerms: GlossaryTerm[]
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
 * Builds the system + user prompt for translating one unit (line/paragraph). Only the glossary
 * entries whose `<term id>` appears in the unit are injected; terms with `ru: null` are listed
 * separately with a transliterate-consistently instruction.
 */
export function buildTranslationPrompt(input: TranslationPromptInput): TranslationPrompt {
  const from = input.sourceLang ?? 'English'
  const to = input.targetLang ?? 'Russian'
  const byId = new Map(input.glossary.terms.map((t) => [t.id, t]))
  const usedTerms = termIdsIn(input.text)
    .map((id) => byId.get(id))
    .filter((t): t is GlossaryTerm => t !== undefined)
  const known = usedTerms.filter((t) => t.ru !== null && t.ru.trim() !== '')
  const untranslatedTerms = usedTerms.filter((t) => t.ru === null || t.ru.trim() === '')

  const parts = [
    `You are a professional literary translator. Translate the user text from ${from} to ${to}.`,
    'Rules:',
    '- Output exactly one translated line per input line; do not add, merge or drop lines (the single trailing <terms> block below is metadata, not a translation line).',
    '- Never split a long line into several lines: keep each input line as ONE output line.',
    '- Keep [bracketed] system messages bracketed.',
    '- Output only the translation: no notes, no quotes around it, no explanations, no <think> blocks.',
    ...(input.extraRules ?? []).map((r) => `- ${r}`),
  ]
  if (known.length > 0) {
    parts.push(
      'Glossary (translate these terms exactly as given):',
      ...known.map((t) => `${t.term} = ${t.ru}`),
    )
  }
  if (untranslatedTerms.length > 0) {
    parts.push(
      `No ${to} translation yet for these terms: transliterate them consistently, the same way every time:`,
      ...untranslatedTerms.map((t) => t.term),
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
  return {
    systemPrompt: parts.join('\n'),
    userPrompt: stripTerms(input.text),
    usedTerms,
    untranslatedTerms,
  }
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
