import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'
import { compileTermMatcher, countTerms, mapProse } from './term-tagger.js'
import type { Glossary, GlossaryTerm, GlossaryTermType } from './term-tagger.js'

/** One chapter of the analysed corpus. */
export interface GlossaryChapter {
  chapter: number
  text: string
}

export interface GlossaryExtractOptions {
  /** Min corpus-wide occurrences for a plain (non-bracketed) candidate. Default: 2. */
  minCount?: number
  /** Terms to never propose (merged with `existing.ignored`). */
  ignored?: string[]
}

const COMMON = new Set(
  (
    'The A An He She It They We I You His Her Its Their Our Your My This That These Those What ' +
    'When Where Why How Who Whom Which But And Or So Then Now If As At In On Of To For With ' +
    'Without By From After Before Chapter Yes No Not Just Even Still There Here Suddenly Perhaps ' +
    'Maybe Please Thank Thanks Well Oh Ah Hmm Okay Ok Once Every Some Many Most Each Both All ' +
    'Another Other Only Also Though Although While Because Since Until Unless Whether Either ' +
    'Neither Nothing Something Anything Everything Someone Anyone Everyone Mr Mrs Ms Dr Sir ' +
    'Do Does Did Is Are Was Were Be Can Could Would Should Will Shall May Might Must Let Look ' +
    'See Come Go Get Got Take Make Know Think Tell Say Said Ask Asked Wait Stop Listen Sorry ' +
    'Good Great Little Big Old New First Last Next One Two Three Four Five Six Seven Eight Nine Ten ' +
    'Today Tomorrow Yesterday Tonight Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'Never Always Maybe Really Actually Finally Instead Meanwhile However Therefore Besides ' +
    'Later Soon Earlier Afterward Eventually Slowly Quickly Finally Then Again Perhaps Inside Outside Behind Above Below Beyond Between Through During Within Against Among'
  ).split(' '),
)

const PLACE =
  /^(City|Kingdom|Mountains?|Forest|River|Lake|Valley|Castle|Village|Town|Temple|Realm|Island|Sea|Desert|Cave|Tower|Gate|Hall|Capital|Plains|Hills|Swamp|Fortress|Palace|Port|Harbor|Peak|Canyon|Ruins|Land|Lands|Mount|Mt)$/
const ITEM =
  /^(Sword|Blade|Ring|Staff|Amulet|Potion|Stone|Armor|Armour|Shield|Crown|Orb|Elixir|Scroll|Bow|Axe|Key|Cloak|Dagger|Spear|Pendant|Necklace|Helm|Helmet|Gauntlets?|Boots|Wand|Tome|Book|Crystal|Gem|Pill|Egg)$/
const SKILL =
  /^(Strike|Slash|Blast|Bolt|Art|Arts|Technique|Skill|Spell|Breath|Aura|Style|Burst|Form|Dash|Shot|Fire|Fireball|Heal|Healing|Step|Shield|Barrier|Roar|Charge|Smash|Cleave|Mastery|Sense|Vision|Resistance)$/
const TERM =
  /^(Order|Guild|Sect|Clan|Academy|Empire|Church|System|Class|Rank|Council|Army|Legion|Alliance|Dynasty|House|Tribe|Race|Level|Quest|Status|Title|Realm|Dragons?|Elf|Elves|Dwarf|Dwarves|Orc|Orcs)$/

/** Best-effort type guess from the term's last word (and the first word for `Mount X`). */
export function guessType(term: string): GlossaryTermType {
  const bracketed = term.startsWith('[')
  const words = term.replace(/^\[|\]$/g, '').split(/\s+/)
  const last = words[words.length - 1] ?? ''
  const first = words[0] ?? ''
  if (PLACE.test(last) || first === 'Mount') return 'place'
  if (ITEM.test(last)) return 'item'
  if (SKILL.test(last)) return 'skill'
  if (TERM.test(last)) return 'term'
  return bracketed ? 'term' : 'character'
}

/** Lowercase, hyphenated, ASCII-ish slug of a term. */
export function slugify(term: string): string {
  const s = term
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'term' : s
}

interface Candidate {
  term: string
  count: number
  firstChapter: number
  type: GlossaryTermType
}

const BRACKET = /\[([^[\]\n]{2,60})\]/g
const MULTI =
  /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)*(?:\s+(?:(?:of(?:\s+the)?|de|von|van|la|le)\s+)?[A-Z][a-z]+(?:[-'][A-Z][a-z]+)*){1,3}/g
const SINGLE = /\b[A-Z][a-z]{2,}\b/g

function isSentenceStart(line: string, index: number): boolean {
  const before = line.slice(0, index).replace(/["'(\[*_\s]+$/u, '')
  return before === '' || /[.!?:]$/.test(before)
}

function bump(map: Map<string, Candidate>, term: string, chapter: number, type?: GlossaryTermType) {
  const c = map.get(term)
  if (c) {
    c.count++
    c.firstChapter = Math.min(c.firstChapter, chapter)
  } else {
    map.set(term, { term, count: 1, firstChapter: chapter, type: type ?? guessType(term) })
  }
}

/** Short `[Name]` labels; system sentences (`[System: ...]`, `[You gained...!]`) are not terms. */
function bracketTerm(inner: string): string | null {
  const t = inner.trim()
  if (/[:!?.,;]/.test(t) || t.split(/\s+/).length > 5 || !/^[A-Za-z]/.test(t)) return null
  return `[${t}]`
}

/** Extracts glossary candidates from a corpus (heuristic, no LLM). Counts are corpus-wide. */
export function extractCandidates(
  chapters: GlossaryChapter[],
  options: GlossaryExtractOptions = {},
): Candidate[] {
  const minCount = options.minCount ?? 2
  const ignored = new Set(options.ignored ?? [])
  const multi = new Map<string, Candidate>()
  const bracketed = new Map<string, Candidate>()
  const mid = new Map<string, Candidate>()
  const capAll = new Map<string, Candidate>()
  const lower = new Map<string, number>()

  for (const { chapter, text } of chapters) {
    mapProse(text, (seg) => {
      for (const word of seg.match(/\b[a-z]{3,}\b/g) ?? [])
        lower.set(word, (lower.get(word) ?? 0) + 1)
      const masked: Array<[number, number]> = []
      for (const m of seg.matchAll(BRACKET)) {
        const term = bracketTerm(m[1] ?? '')
        const at = m.index ?? 0
        masked.push([at, at + m[0].length])
        if (term) bump(bracketed, term, chapter)
      }
      for (const m of seg.matchAll(MULTI)) {
        const at = m.index ?? 0
        if (masked.some(([a, b]) => at < b && at + m[0].length > a)) continue
        // trim leading/trailing common words ("The Black Forest" -> "Black Forest")
        const words = m[0].split(/(\s+)/)
        let lo = 0
        let hi = words.length - 1
        while (
          lo <= hi &&
          (COMMON.has(words[lo] ?? '') || /^[A-Z][a-z]+ing$/.test(words[lo] ?? ''))
        )
          lo += 2
        while (hi >= lo && COMMON.has(words[hi] ?? '')) hi -= 2
        if (hi - lo < 2) continue
        const term = words.slice(lo, hi + 1).join('')
        const start = at + words.slice(0, lo).join('').length
        masked.push([start, start + term.length])
        bump(multi, term, chapter)
      }
      for (const m of seg.matchAll(SINGLE)) {
        const at = m.index ?? 0
        const w = m[0]
        if (COMMON.has(w)) continue
        if (masked.some(([a, b]) => at >= a && at < b)) continue
        bump(capAll, w, chapter)
        if (!isSentenceStart(seg, at)) bump(mid, w, chapter)
      }
      return seg
    })
  }

  const out: Candidate[] = []
  for (const c of bracketed.values()) out.push(c)
  for (const c of multi.values()) if (c.count >= minCount) out.push(c)
  for (const c of capAll.values()) {
    const midCount = mid.get(c.term)?.count ?? 0
    const low = lower.get(c.term.toLowerCase()) ?? 0
    const repeatedMid = midCount >= 2 && midCount >= low
    const alwaysCap = c.count >= Math.max(3, minCount) && low === 0
    if (repeatedMid || alwaysCap) out.push(c)
  }
  return out.filter((c) => !ignored.has(c.term))
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/**
 * Builds (or updates) the glossary for a corpus.
 *
 * - Existing entries are kept as-is (order, `id`, `type`, `ru`, `aliases`, manual edits and
 *   human-added terms); only `count` / `firstChapter` are recomputed from the corpus.
 * - New candidates are appended (count desc), ids are unique.
 * - Terms listed in `existing.ignored` are never re-added.
 */
export function buildGlossary(
  chapters: GlossaryChapter[],
  existing?: Glossary,
  options: GlossaryExtractOptions = {},
): Glossary {
  const ignored = [...new Set([...(existing?.ignored ?? []), ...(options.ignored ?? [])])]
  const known = new Set<string>()
  const taken = new Set<string>()
  const terms: GlossaryTerm[] = []
  for (const t of existing?.terms ?? []) {
    terms.push({ ...t, aliases: [...(t.aliases ?? [])], ru: t.ru ?? null })
    taken.add(t.id)
    known.add(t.term)
    for (const a of t.aliases ?? []) known.add(a)
  }
  const fresh = extractCandidates(chapters, { ...options, ignored })
    .filter((c) => !known.has(c.term))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  for (const c of fresh) {
    terms.push({
      id: uniqueId(slugify(c.term), taken),
      term: c.term,
      type: c.type,
      count: c.count,
      firstChapter: c.firstChapter,
      ru: null,
      aliases: [],
    })
  }

  // Recount every entry with the tagger's own matching rules (existing + new, consistent).
  const glossary: Glossary = { terms, ignored }
  const matcher = compileTermMatcher(glossary)
  const totals = new Map<string, number>()
  const first = new Map<string, number>()
  for (const { chapter, text } of [...chapters].sort((a, b) => a.chapter - b.chapter)) {
    for (const [id, n] of countTerms(text, glossary, matcher)) {
      totals.set(id, (totals.get(id) ?? 0) + n)
      if (!first.has(id)) first.set(id, chapter)
    }
  }
  for (const t of terms) {
    t.count = totals.get(t.id) ?? 0
    t.firstChapter = first.get(t.id) ?? t.firstChapter ?? null
  }
  return glossary
}

/** Parses a `glossary.json` text; `undefined` for empty or malformed input. */
export function parseGlossary(json: string): Glossary | undefined {
  try {
    const raw = JSON.parse(json) as Partial<Glossary>
    if (!raw || !Array.isArray(raw.terms)) return undefined
    return { terms: raw.terms, ...(raw.ignored ? { ignored: raw.ignored } : {}) }
  } catch {
    return undefined
  }
}

/** Stable pretty JSON for `glossary.json` (human-editable). */
export function serializeGlossary(glossary: Glossary): string {
  return `${JSON.stringify({ terms: glossary.terms, ignored: glossary.ignored ?? [] }, null, 2)}\n`
}

/** Chapter number from a `# Chapter N` heading, else the fallback. */
export function chapterNumberOf(md: string, fallback: number): number {
  const n = /^#\s*Chapter\s+(\d+)/im.exec(md)?.[1]
  return n ? Number(n) : fallback
}

export interface GlossaryExtractorToolOptions extends GlossaryExtractOptions {
  /** Loads the existing glossary (e.g. from `chapters/glossary.json`). */
  load?: () => Promise<Glossary | undefined> | Glossary | undefined
}

/**
 * Tool: builds/updates the glossary from `env.items` (batched corpus) or `env.item`.
 * Item untouched; result in `meta.glossary` (+ `meta.glossaryJson`, `meta.chapterNums`).
 */
export function createGlossaryExtractor(options: GlossaryExtractorToolOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'glossary-extractor',
    version: '1.0.0',
    mdDescription:
      'Heuristic glossary extraction (capitalised names, [Bracketed] terms, repeated capitalised ' +
      'nouns) with type guess, count and firstChapter; merges into an existing glossary keeping ' +
      '`ru`, `aliases` and manual edits. Stores `meta.glossary`.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const inputs = (env.items ?? [env.item]).flat()
      const chapterNums = inputs.map((t, i) => chapterNumberOf(t, i + 1))
      const existing = await options.load?.()
      const glossary = buildGlossary(
        inputs.map((text, i) => ({ chapter: chapterNums[i] ?? i + 1, text })),
        existing,
        options,
      )
      return {
        ...env,
        meta: { ...env.meta, glossary, glossaryJson: serializeGlossary(glossary), chapterNums },
      }
    },
  })
}

export const glossaryExtractor = createGlossaryExtractor()
