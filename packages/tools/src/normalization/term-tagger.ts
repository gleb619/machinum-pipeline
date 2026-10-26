import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'
import type { RuGrammar } from './ru-grammar.js'

/** Kind of glossary entry (best-effort guess; humans may edit it). */
export type GlossaryTermType = 'character' | 'place' | 'item' | 'skill' | 'term'

/** One chapter of the analysed corpus. */
export interface GlossaryChapter {
  chapter: number
  text: string
}

/** One glossary entry. `ru` and `aliases` are meant to be filled/edited by a human. */
export interface GlossaryTerm {
  /** Stable slug used in `<term id="...">`. */
  id: string
  /** Canonical EN surface form (bracketed terms keep their `[` `]`). */
  term: string
  type: GlossaryTermType
  /** Occurrences in the analysed corpus. */
  count: number
  /** First chapter number the term appears in (`null` when it was never found). */
  firstChapter: number | null
  /** Human-provided RU translation (`null` until filled). */
  ru: string | null
  /** Other EN surface forms tagged with the same id. */
  aliases: string[]
  /** Related glossary terms (relation graph edges); term names, not ids. */
  references?: string[]
  /** What the term means in the story (model-reported). */
  description?: string
  /** Model-reported RU translations awaiting human approval (never auto-applied). */
  pending?: string[]
  /**
   * Human-fixed term: `ru`/`type` are final — auto-merge never changes them and model
   * proposals are never queued. Always injected into translation prompts, even when
   * the term does not occur in the unit text.
   */
  locked?: boolean
  /** Optional Russian morphology metadata (gender, declension, inflection endings). */
  ruGrammar?: RuGrammar
}

/** `chapters/glossary.json` shape. */
export interface Glossary {
  terms: GlossaryTerm[]
  /** Terms the extractor must never propose again (human-maintained). */
  ignored?: string[]
  /** RU values the human rejected: auto-merge never applies or re-queues them. */
  rejected?: string[]
}

const TAG_RE = /<term id="[^"]*">([\s\S]*?)<\/term>/g
const WORD_CHAR = '\\p{L}\\p{N}_'

/** Inverse of {@link tagTerms}: drops every `<term id="..">..</term>` wrapper, keeping the text. */
export function stripTerms(text: string): string {
  return text.replace(TAG_RE, '$1')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compiled matcher: longest surface form wins at each position, forms never nest. */
export interface TermMatcher {
  regex: RegExp | null
  idOf: Map<string, string>
}

/** Compiles every term and alias of a glossary into one longest-first alternation. */
export function compileTermMatcher(glossary: Glossary): TermMatcher {
  const idOf = new Map<string, string>()
  for (const t of glossary.terms) {
    for (const form of [t.term, ...t.aliases]) {
      const surface = form.trim()
      if (surface !== '' && !idOf.has(surface)) idOf.set(surface, t.id)
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

/**
 * Applies `fn` to prose only: fenced code blocks, inline code spans and `#` heading lines are
 * passed through untouched. Line structure is never changed.
 */
export function mapProse(text: string, fn: (segment: string) => string): string {
  let fence: string | null = null
  return text
    .split('\n')
    .map((line) => {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1]
      if (fence) {
        if (marker === fence) fence = null
        return line
      }
      if (marker) {
        fence = marker
        return line
      }
      if (/^\s*#{1,6}\s/.test(line)) return line
      return line
        .split(/(`[^`\n]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : fn(part)))
        .join('')
    })
    .join('\n')
}

/**
 * Wraps every glossary term occurrence as `<term id="ID">text</term>`.
 * Longest match first, no nesting, code skipped, idempotent (existing tags are stripped first),
 * line and paragraph count unchanged. `stripTerms(tagTerms(x, g)) === x` for any `x` that does
 * not already contain `<term>` tags.
 */
export function tagTerms(text: string, glossary: Glossary, matcher?: TermMatcher): string {
  const base = stripTerms(text)
  const { regex, idOf } = matcher ?? compileTermMatcher(glossary)
  if (!regex) return base
  return mapProse(base, (seg) =>
    seg.replace(regex, (m) => {
      const id = idOf.get(m)
      return id === undefined ? m : `<term id="${id}">${m}</term>`
    }),
  )
}

/** Occurrences per term id (same matching rules as {@link tagTerms}). */
export function countTerms(
  text: string,
  glossary: Glossary,
  matcher?: TermMatcher,
): Map<string, number> {
  const counts = new Map<string, number>()
  const { regex, idOf } = matcher ?? compileTermMatcher(glossary)
  if (!regex) return counts
  mapProse(stripTerms(text), (seg) => {
    for (const m of seg.matchAll(regex)) {
      const id = idOf.get(m[0])
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return seg
  })
  return counts
}

/**
 * Tool: tags the glossary terms (`meta.glossary`) in `env.item` / `env.items`. The item is left
 * untouched; results land in `meta.taggedItems` (parallel to the inputs) and `meta.tagged`
 * (first one). Without a glossary the text is passed through unchanged.
 */
export const termTagger = defineTool<string | string[], string | string[]>({
  name: 'term-tagger',
  version: '1.0.0',
  mdDescription:
    'Wraps glossary terms as `<term id="ID">text</term>` (longest first, no nesting, skips code, ' +
    'idempotent, line count preserved). Result in `meta.taggedItems`; `stripTerms` reverses it.',
  async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
    const glossary = (env.meta.glossary as Glossary | undefined) ?? { terms: [] }
    const matcher = compileTermMatcher(glossary)
    const inputs = (env.items ?? [env.item]).flat()
    const taggedItems = inputs.map((t) => tagTerms(t, glossary, matcher))
    return { ...env, meta: { ...env.meta, taggedItems, tagged: taggedItems[0] ?? '' } }
  },
})
