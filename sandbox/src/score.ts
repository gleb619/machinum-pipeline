/** Pure scoring functions for translation output. All scores are 0..1 unless noted. */

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** 1 when EN and RU have the same number of non-empty lines, else min/max ratio. */
export function paragraphParity(en: string, ru: string): number {
  const a = splitLines(en).length
  const b = splitLines(ru).length
  if (a === 0 && b === 0) return 1
  if (a === 0 || b === 0) return 0
  return Math.min(a, b) / Math.max(a, b)
}

/** True when line counts are exactly equal. */
export function paragraphParityExact(en: string, ru: string): boolean {
  return splitLines(en).length === splitLines(ru).length
}

/** Share of glossary terms (present in `en`) whose RU form appears in `ru` (case-insensitive). */
export function glossaryHits(ru: string, glossary: Record<string, string>, en?: string): number {
  const lowRu = ru.toLowerCase()
  const lowEn = en?.toLowerCase()
  const terms = Object.entries(glossary).filter(([term]) =>
    lowEn === undefined ? true : lowEn.includes(term.toLowerCase()),
  )
  if (terms.length === 0) return 1
  const hit = terms.filter(([, tr]) => lowRu.includes(tr.toLowerCase())).length
  return hit / terms.length
}

/** Cyrillic letters / all letters. 0 when no letters. */
export function cyrillicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) return 0
  const cyr = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0
  return cyr / letters
}

/** True when output is blank or (near-)identical to the source. */
export function emptyOrEcho(en: string, ru: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const r = norm(ru)
  return r === '' || r === norm(en)
}

export interface ScoreInput {
  en: string
  ru: string
  glossary: Record<string, string>
}

export interface ScoreResult {
  parity: number
  glossary: number
  cyrillic: number
  failed: boolean
  score: number
}

const WEIGHTS = { parity: 0.3, glossary: 0.3, cyrillic: 0.4 }

/** Aggregate: weighted parity/glossary/cyrillic; 0 for empty or echoed output. */
export function scoreTranslation({ en, ru, glossary }: ScoreInput): ScoreResult {
  const failed = emptyOrEcho(en, ru)
  const parity = paragraphParity(en, ru)
  const gl = glossaryHits(ru, glossary, en)
  const cyr = Math.min(1, cyrillicRatio(ru))
  const score = failed
    ? 0
    : WEIGHTS.parity * parity + WEIGHTS.glossary * gl + WEIGHTS.cyrillic * cyr
  return { parity, glossary: gl, cyrillic: cyr, failed, score }
}
