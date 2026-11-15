/**
 * Read-only comparison of two frozen runs (`runs/<label>/`).
 *
 *   pnpm run compare baseline tuned
 *   pnpm run compare baseline tuned --out reports/my-report.md
 *
 * Per chapter common to both runs it reports EN/RU line counts, line-parity errors, Cyrillic
 * share, RU/EN length ratio, foreign-script hits and metadata leaks, then adds the per-stage
 * wall time delta and the config diff. A Names section compares the RU text against
 * `chapters/names.json` and reports pinned-name hits versus drifting variants. Exit 1 only when
 * either run has a hard defect; name drift is a quality signal, not a failure.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintLineParity } from '@mt/tools'
import { ROOT } from '../lib/llm.js'
import type { BackupMeta } from './backup-run.js'
import { BOOK_STAGES, type TimingsRecord } from './run-book.js'

const CYRILLIC = /[\u0400-\u04ff]/g
const LETTER = /\p{L}/gu
const METADATA = /<(terms|result|id|translated)\b/gi
const CYRILLIC_WORD = /[\u0400-\u04ff]+/gu
const VOWELS = new Set([...'\u0430\u0435\u0451\u0438\u043e\u0443\u044b\u044d\u044e\u044f'])
const NAME_ENDINGS = [
  '\u043e\u0439',
  '\u0435\u0439',
  '\u043e\u043c',
  '\u0435\u043c',
  '\u0430\u043c',
  '\u044f\u043c',
  '\u0430\u0445',
  '\u044f\u0445',
  '',
  '\u0430',
  '\u044f',
  '\u0443',
  '\u044e',
  '\u0435',
  '\u0438',
  '\u044b',
]

export interface ChapterQuality {
  chapter: number
  enLines: number
  ruLines: number
  parityErrors: number
  warnings: number
  firstIssue?: string
  cyrShare: number
  lenRatio: number
  foreignScript: number
  metadataLeaks: number
  ok: boolean
}

export interface RunDefects {
  chapters: number
  okChapters: number
  parityErrors: number
  foreignScript: number
  metadataLeaks: number
  hard: number
}

export interface NameEntryStats {
  name: string
  /** Occurrences of the exact pinned form or its genitive. */
  table: number
  /** Occurrences of drifting tokens attributed to this name. */
  variants: number
}

export interface NameVariantRow {
  name: string
  variant: string
  count: number
}

export interface NameStats {
  entries: NameEntryStats[]
  seen: number
  tableHits: number
  variantHits: number
  topVariants: NameVariantRow[]
}

export interface CompareOptions {
  /** Run directory A (e.g. `runs/baseline`). */
  a: string
  /** Run directory B. */
  b: string
}

export interface CompareResult {
  markdown: string
  defects: { a: RunDefects; b: RunDefects; total: number }
}

interface RunData {
  dir: string
  label: string
  meta?: BackupMeta
  timings?: TimingsRecord
  chapters: ChapterQuality[]
  enFiles: number
  ruFiles: number
  names?: NameStats
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function chapterNumbers(dir: string): Promise<number[]> {
  try {
    const names = await readdir(join(dir, 'chapters/en'))
    const numbers = names
      .map((name) => /^chapter(\d+)\.md$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
    return [...new Set(numbers)].sort((x, y) => x - y)
  } catch {
    return []
  }
}

async function countMarkdown(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).length
  } catch {
    return 0
  }
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length
}

function cyrillicTokens(text: string): string[] {
  return text.match(CYRILLIC_WORD) ?? []
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Count whole Cyrillic-word occurrences of `phrase` in `text` (case-insensitive). */
function countPhrase(text: string, phrase: string): number {
  if (phrase === '') return 0
  const re = new RegExp(`(?<![\\u0400-\\u04ff])${escapeRegExp(phrase)}(?![\\u0400-\\u04ff])`, 'giu')
  return text.match(re)?.length ?? 0
}

/** Strip a Russian case ending to get the shared stem; `Надя` and `Нади` both yield `Над`. */
function russianStem(form: string): string {
  for (const ending of NAME_ENDINGS) {
    if (ending !== '' && form.endsWith(ending) && form.length - ending.length >= 2) {
      return form.slice(0, -ending.length)
    }
  }
  return form
}

/** Every simple inflection of a stem using the allowed name endings. */
function inflections(form: string): string[] {
  const stem = russianStem(form)
  return NAME_ENDINGS.map((ending) => stem + ending)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0
  const limit = Math.min(a.length, b.length)
  while (length < limit && a[length] === b[length]) length++
  return length
}

function vowelCount(word: string): number {
  let count = 0
  for (const char of word) if (VOWELS.has(char)) count++
  return count
}

/**
 * A token drifts from a pinned form when it is one edit away with a shared two-letter prefix
 * (`Дойл` ↔ `Доул`, `Надия` ↔ `Нади`) or two edits away after the first letter with the same
 * vowel count (`Фиона` ↔ `Файона`). Unrelated words sharing a stem are filtered by the prefix
 * and vowel guards, and callers require the token to be name-like (capitalised, not a common
 * lowercase word).
 */
function isNameVariant(token: string, form: string): boolean {
  if (token[0] !== form[0]) return false
  const distance = levenshtein(token, form)
  if (distance === 1 && commonPrefixLength(token, form) >= 2) return true
  return (
    distance === 2 &&
    token.length >= 5 &&
    vowelCount(token) === vowelCount(form) &&
    commonPrefixLength(token, form) <= 1
  )
}

interface NameTableEntry {
  name: string
  ru: string
  gen: string
}

interface NameForm {
  name: string
  token: string
  words: number
}

async function loadNameTable(dir: string): Promise<NameTableEntry[]> {
  const data = await readJson<Record<string, unknown>>(join(dir, 'chapters/names.json'))
  if (data === undefined) return []
  const entries: NameTableEntry[] = []
  for (const group of Object.values(data)) {
    if (typeof group !== 'object' || group === null) continue
    for (const [name, value] of Object.entries(group as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      const ru = record.ru
      if (typeof ru !== 'string' || ru === '') continue
      const gen = typeof record.gen === 'string' && record.gen !== '' ? record.gen : ru
      entries.push({ name, ru, gen })
    }
  }
  return entries
}

async function readRuCorpus(dir: string): Promise<string> {
  const ruDir = join(dir, 'chapters/ru')
  let files: string[]
  try {
    files = await readdir(ruDir)
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
    const text = await readText(join(ruDir, file))
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Compare a run's RU chapters against its `chapters/names.json`: count pinned forms and
 * attribute drifting Cyrillic tokens to the closest pinned name. Read-only.
 */
export async function analyzeNames(dir: string): Promise<NameStats | undefined> {
  const table = await loadNameTable(dir)
  if (table.length === 0) return undefined
  const text = await readRuCorpus(dir)
  const tokens = cyrillicTokens(text)

  const lowercaseSeen = new Set<string>()
  for (const token of tokens) {
    const first = token[0] ?? ''
    if (/[а-яё]/.test(first)) lowercaseSeen.add(token.toLowerCase())
  }

  const correct = new Set<string>()
  const forms: NameForm[] = []
  for (const entry of table) {
    const tokenSet = new Set<string>()
    for (const phrase of new Set([entry.ru, entry.gen])) {
      for (const token of cyrillicTokens(phrase)) tokenSet.add(token.toLowerCase())
    }
    const wordCount = cyrillicTokens(entry.ru).length
    for (const token of tokenSet) {
      for (const form of inflections(token)) correct.add(form)
      forms.push({ name: entry.name, token, words: wordCount })
    }
  }

  const variantsByEntry = new Map<string, number>()
  const variantRows = new Map<string, NameVariantRow>()
  for (const raw of tokens) {
    const token = raw.toLowerCase()
    if (token.length < 4 || correct.has(token)) continue
    if (!/[А-ЯЁ]/.test(raw[0] ?? '')) continue
    if (lowercaseSeen.has(token)) continue
    let best: NameForm | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const form of forms) {
      if (!isNameVariant(token, form.token)) continue
      const distance = levenshtein(token, form.token)
      const better =
        best === undefined ||
        distance < bestDistance ||
        (distance === bestDistance && form.words < best.words) ||
        (distance === bestDistance && form.words === best.words && form.name < best.name)
      if (better) {
        best = form
        bestDistance = distance
      }
    }
    if (best === undefined) continue
    variantsByEntry.set(best.name, (variantsByEntry.get(best.name) ?? 0) + 1)
    const key = `${best.name}\u0000${token}`
    const row = variantRows.get(key)
    if (row) row.count += 1
    else variantRows.set(key, { name: best.name, variant: raw, count: 1 })
  }

  let tableHits = 0
  const tableByEntry = new Map<string, number>()
  for (const entry of table) {
    let hits = 0
    for (const phrase of new Set([entry.ru, entry.gen])) hits += countPhrase(text, phrase)
    tableByEntry.set(entry.name, hits)
    tableHits += hits
  }
  const seen = table.filter(
    (entry) => (tableByEntry.get(entry.name) ?? 0) + (variantsByEntry.get(entry.name) ?? 0) > 0,
  ).length

  const entries: NameEntryStats[] = table.map((entry) => ({
    name: entry.name,
    table: tableByEntry.get(entry.name) ?? 0,
    variants: variantsByEntry.get(entry.name) ?? 0,
  }))
  entries.sort(
    (x, y) => y.variants - x.variants || y.table - x.table || x.name.localeCompare(y.name),
  )

  const topVariants = [...variantRows.values()]
    .sort(
      (x, y) =>
        y.count - x.count || x.variant.localeCompare(y.variant) || x.name.localeCompare(y.name),
    )
    .slice(0, 5)

  const variantHits = [...variantsByEntry.values()].reduce((sum, value) => sum + value, 0)
  return { entries, seen, tableHits, variantHits, topVariants }
}

async function readChapter(dir: string, chapter: number): Promise<ChapterQuality | undefined> {
  const en = await readText(join(dir, 'chapters/en', `chapter${chapter}.md`))
  const ru = await readText(join(dir, 'chapters/ru', `chapter${chapter}.md`))
  if (en === undefined || ru === undefined) return undefined

  const report = lintLineParity(en, ru)
  const first = report.issues.find((issue) => issue.severity === 'error') ?? report.issues[0]
  const letters = count(LETTER, ru)
  const foreignScript = report.issues.filter((issue) => issue.code === 'foreign-script').length
  const metadataLeaks = count(METADATA, ru)
  const enWords = words(en)
  const lenRatio = enWords === 0 ? 0 : words(ru) / enWords

  return {
    chapter,
    enLines: report.enLines,
    ruLines: report.ruLines,
    parityErrors: report.errors,
    warnings: report.warnings,
    ...(first ? { firstIssue: `${first.code}${first.line ? `@${first.line}` : ''}` } : {}),
    cyrShare: letters === 0 ? 0 : count(CYRILLIC, ru) / letters,
    lenRatio,
    foreignScript,
    metadataLeaks,
    ok: report.ok && foreignScript === 0 && metadataLeaks === 0,
  }
}

async function loadRun(dir: string): Promise<RunData> {
  const meta = await readJson<BackupMeta>(join(dir, 'meta.json'))
  const timings = await readJson<TimingsRecord>(join(dir, 'timings.json'))
  const numbers = await chapterNumbers(dir)
  const chapters: ChapterQuality[] = []
  for (const chapter of numbers) {
    const quality = await readChapter(dir, chapter)
    if (quality) chapters.push(quality)
  }
  const names = await analyzeNames(dir)
  return {
    dir,
    label: meta?.label ?? basename(dir),
    ...(meta ? { meta } : {}),
    ...(timings ? { timings } : {}),
    chapters,
    enFiles: meta?.counts.en ?? (await countMarkdown(join(dir, 'chapters/en'))),
    ruFiles: await countMarkdown(join(dir, 'chapters/ru')),
    ...(names ? { names } : {}),
  }
}

function summarize(run: RunData): RunDefects {
  const parityErrors = run.chapters.reduce((sum, chapter) => sum + chapter.parityErrors, 0)
  const foreignScript = run.chapters.reduce((sum, chapter) => sum + chapter.foreignScript, 0)
  const metadataLeaks = run.chapters.reduce((sum, chapter) => sum + chapter.metadataLeaks, 0)
  return {
    chapters: run.chapters.length,
    okChapters: run.chapters.filter((chapter) => chapter.ok).length,
    parityErrors,
    foreignScript,
    metadataLeaks,
    hard: parityErrors + foreignScript + metadataLeaks,
  }
}

function shortHead(head: string | null | undefined): string {
  return head ? head.slice(0, 10) : '-'
}

function stageOrder(a: RunData, b: RunData): string[] {
  const seen = new Set<string>([
    ...Object.keys(a.timings?.stages ?? {}),
    ...Object.keys(b.timings?.stages ?? {}),
  ])
  const ordered: string[] = BOOK_STAGES.filter((stage) => seen.has(stage))
  for (const stage of seen) if (!ordered.includes(stage)) ordered.push(stage)
  return ordered
}

function fmtMs(ms: number | undefined): string {
  return ms === undefined ? '-' : (ms / 1000).toFixed(2)
}

function fmtNumber(value: number, digits: number): string {
  return value.toFixed(digits)
}

function metaCell(value: string | undefined): string {
  return value === undefined || value === '' ? '-' : value
}

function configDiffRows(a: RunData, b: RunData): Array<[string, string, string]> {
  const keys = new Set([...Object.keys(a.meta?.knobs ?? {}), ...Object.keys(b.meta?.knobs ?? {})])
  const rows: Array<[string, string, string]> = []
  for (const key of [...keys].sort()) {
    const left = metaCell(a.meta?.knobs[key])
    const right = metaCell(b.meta?.knobs[key])
    if (left !== right) rows.push([key, left, right])
  }
  return rows
}

function modelStageRows(a: RunData, b: RunData): Array<[string, string, string]> {
  const keys = new Set([
    ...Object.keys(a.meta?.resolved.perStage ?? {}),
    ...Object.keys(b.meta?.resolved.perStage ?? {}),
  ])
  return [...keys]
    .sort()
    .map((stage) => [
      stage,
      metaCell(a.meta?.resolved.perStage[stage]),
      metaCell(b.meta?.resolved.perStage[stage]),
    ])
}

function qualityRow(chapter: number, qa?: ChapterQuality, qb?: ChapterQuality): string {
  const cells: string[] = [`chapter ${chapter}`]
  const pair = (pick: (q: ChapterQuality) => string, blank = '-') =>
    cells.push(qa ? pick(qa) : blank, qb ? pick(qb) : blank)
  pair((q) => String(q.enLines))
  pair((q) => String(q.ruLines))
  pair((q) => String(q.parityErrors))
  pair((q) => fmtNumber(q.cyrShare, 2))
  pair((q) => fmtNumber(q.lenRatio, 2))
  pair((q) => String(q.foreignScript))
  pair((q) => String(q.metadataLeaks))
  const defective = (qa && !qa.ok) || (qb && !qb.ok)
  if (defective) cells[0] = `**chapter ${chapter}**`
  return `| ${cells.join(' | ')} |`
}

/**
 * Build the markdown report for two run directories. Pure apart from reading the two trees;
 * never writes anything.
 */
export async function compareRuns(options: CompareOptions): Promise<CompareResult> {
  const [a, b] = await Promise.all([loadRun(options.a), loadRun(options.b)])
  const defects = { a: summarize(a), b: summarize(b), total: 0 }
  defects.total = defects.a.hard + defects.b.hard

  const lines: string[] = []
  lines.push(`# Run comparison: ${a.label} vs ${b.label}`)
  lines.push('')
  lines.push('| field | A | B |')
  lines.push('|---|---|---|')
  lines.push(`| label | ${a.label} | ${b.label} |`)
  lines.push(`| git HEAD | ${shortHead(a.meta?.gitHead)} | ${shortHead(b.meta?.gitHead)} |`)
  lines.push(`| ran at | ${metaCell(a.meta?.createdAt)} | ${metaCell(b.meta?.createdAt)} |`)
  lines.push(
    `| backend | ${metaCell(a.meta?.resolved.tool)} | ${metaCell(b.meta?.resolved.tool)} |`,
  )
  lines.push(`| chapters (EN / RU) | ${a.enFiles} / ${a.ruFiles} | ${b.enFiles} / ${b.ruFiles} |`)
  lines.push('')
  lines.push('## Resolved models')
  lines.push('')
  lines.push('| stage | A | B |')
  lines.push('|---|---|---|')
  for (const row of modelStageRows(a, b)) lines.push(`| ${row.join(' | ')} |`)
  lines.push('')

  lines.push('## Config diff')
  lines.push('')
  const diffs = configDiffRows(a, b)
  if (diffs.length === 0) {
    lines.push('No differing knobs.')
  } else {
    lines.push('| knob | A | B |')
    lines.push('|---|---|---|')
    for (const row of diffs) lines.push(`| ${row.join(' | ')} |`)
  }
  lines.push('')

  lines.push('## Time')
  lines.push('')
  lines.push('| stage | A (s) | B (s) | delta (s) | × |')
  lines.push('|---|---|---|---|---|')
  for (const stage of stageOrder(a, b)) {
    const left = a.timings?.stages[stage]?.ms
    const right = b.timings?.stages[stage]?.ms
    const delta = left !== undefined && right !== undefined ? (right - left) / 1000 : undefined
    const ratio =
      left !== undefined && right !== undefined && left > 0 ? (right / left).toFixed(2) : '-'
    lines.push(
      `| ${stage} | ${fmtMs(left)} | ${fmtMs(right)} | ${delta === undefined ? '-' : delta.toFixed(2)} | ${ratio} |`,
    )
  }
  const totalA = a.timings?.totalMs
  const totalB = b.timings?.totalMs
  const totalDelta =
    totalA !== undefined && totalB !== undefined ? ((totalB - totalA) / 1000).toFixed(2) : '-'
  const totalRatio =
    totalA !== undefined && totalB !== undefined && totalA > 0 ? (totalB / totalA).toFixed(2) : '-'
  lines.push(`| **total** | ${fmtMs(totalA)} | ${fmtMs(totalB)} | ${totalDelta} | ${totalRatio} |`)
  lines.push('')
  const chaptersA = a.timings?.stages.chapters?.ms
  const chaptersB = b.timings?.stages.chapters?.ms
  const perChapter = (ms: number | undefined, files: number) =>
    ms !== undefined && files > 0 ? `${(ms / files).toFixed(0)} ms` : '-'
  lines.push(
    `chapters stage: A ${perChapter(chaptersA, a.ruFiles)}/chapter, B ${perChapter(chaptersB, b.ruFiles)}/chapter`,
  )
  lines.push('')

  lines.push('## Quality')
  lines.push('')
  lines.push(
    '| chapter | EN A | EN B | RU A | RU B | err A | err B | cyr A | cyr B | ratio A | ratio B | foreign A | foreign B | leaks A | leaks B |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const allChapters = [...new Set([...a.chapters, ...b.chapters].map((c) => c.chapter))].sort(
    (x, y) => x - y,
  )
  for (const chapter of allChapters) {
    lines.push(
      qualityRow(
        chapter,
        a.chapters.find((c) => c.chapter === chapter),
        b.chapters.find((c) => c.chapter === chapter),
      ),
    )
  }
  lines.push('')
  const defectNotes = [
    ...a.chapters.map((c) => ({ run: 'A', c })),
    ...b.chapters.map((c) => ({ run: 'B', c })),
  ]
    .filter((entry) => !entry.c.ok)
    .map(
      (entry) =>
        `- ${entry.run} chapter ${entry.c.chapter}: ${entry.c.firstIssue ?? 'defect'} (errors ${entry.c.parityErrors}, foreign ${entry.c.foreignScript}, leaks ${entry.c.metadataLeaks})`,
    )
  if (defectNotes.length > 0) {
    lines.push('Defects:')
    lines.push('')
    for (const note of defectNotes) lines.push(note)
    lines.push('')
  }

  lines.push('## Names')
  lines.push('')
  const nameSummary = (run: RunData) =>
    run.names === undefined
      ? 'n/a (no chapters/names.json)'
      : `${run.names.seen} table name(s), ${run.names.tableHits} pinned hits, ${run.names.variantHits} variant hits`
  lines.push(`- **${a.label}**: ${nameSummary(a)}`)
  lines.push(`- **${b.label}**: ${nameSummary(b)}`)
  lines.push('')
  const variantRowsA = a.names?.topVariants ?? []
  const variantRowsB = b.names?.topVariants ?? []
  if (variantRowsA.length === 0 && variantRowsB.length === 0) {
    lines.push('No name variants in either run.')
  } else {
    lines.push('| run | name → variant | hits |')
    lines.push('|---|---|---|')
    for (const row of variantRowsA) {
      lines.push(`| A | ${row.name} → ${row.variant} | ${row.count} |`)
    }
    for (const row of variantRowsB) {
      lines.push(`| B | ${row.name} → ${row.variant} | ${row.count} |`)
    }
  }
  lines.push('')
  const perName = new Map<string, { a?: NameEntryStats; b?: NameEntryStats }>()
  for (const stat of a.names?.entries ?? []) perName.set(stat.name, { a: stat })
  for (const stat of b.names?.entries ?? []) {
    const existing = perName.get(stat.name) ?? {}
    perName.set(stat.name, { ...existing, b: stat })
  }
  if (perName.size > 0) {
    const rows = [...perName.entries()].sort(([nameX, x], [nameY, y]) => {
      const variants =
        (y.a?.variants ?? 0) + (y.b?.variants ?? 0) - (x.a?.variants ?? 0) - (x.b?.variants ?? 0)
      if (variants !== 0) return variants
      const table = (y.a?.table ?? 0) + (y.b?.table ?? 0) - (x.a?.table ?? 0) - (x.b?.table ?? 0)
      if (table !== 0) return table
      return nameX.localeCompare(nameY)
    })
    const cell = (stat?: NameEntryStats) =>
      stat === undefined ? '-' : `${stat.table}/${stat.variants}`
    lines.push('| name | A table/variant | B table/variant |')
    lines.push('|---|---|---|')
    for (const [name, stats] of rows) {
      lines.push(`| ${name} | ${cell(stats.a)} | ${cell(stats.b)} |`)
    }
    lines.push('')
  }

  const verdict = (run: RunData, summary: RunDefects) =>
    `- **${run.label}**: parity ok ${summary.okChapters}/${summary.chapters} chapters; ${summary.hard} hard defect(s); ${fmtMs(run.timings?.totalMs)}s total`
  const nameVerdict = (run: RunData) =>
    run.names === undefined
      ? `- **${run.label}** names: n/a`
      : `- **${run.label}** names: ${run.names.seen} table name(s), ${run.names.tableHits} pinned hits, ${run.names.variantHits} variant hits`
  const variantsOf = (run: RunData) => run.names?.variantHits ?? 0
  const qualityWinner =
    defects.a.hard !== defects.b.hard
      ? defects.a.hard < defects.b.hard
        ? a.label
        : b.label
      : variantsOf(a) === variantsOf(b)
        ? 'tie'
        : variantsOf(a) < variantsOf(b)
          ? a.label
          : b.label
  const speedWinner =
    totalA === undefined || totalB === undefined
      ? 'unknown (missing timings)'
      : totalA === totalB
        ? 'tie'
        : totalA < totalB
          ? a.label
          : b.label

  lines.push('## Verdict')
  lines.push('')
  lines.push(verdict(a, defects.a))
  lines.push(verdict(b, defects.b))
  lines.push(nameVerdict(a))
  lines.push(nameVerdict(b))
  lines.push('')
  lines.push(`quality winner: **${qualityWinner}**`)
  lines.push(`speed winner: **${speedWinner}**`)
  lines.push('')

  return { markdown: lines.join('\n'), defects }
}

interface CliArgs {
  a: string
  b: string
  out?: string
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') out = argv[++i]
    else positional.push(arg)
  }
  return {
    a: positional[0] ?? '',
    b: positional[1] ?? '',
    ...(out !== undefined ? { out } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args.a || !args.b) {
      console.error('usage: tsx scripts/compare-runs.ts <labelA> <labelB> [--out <path>]')
      process.exit(2)
    }
    const out = resolve(args.out ?? join(ROOT, 'reports', `compare-${args.a}-vs-${args.b}.md`))
    const result = await compareRuns({
      a: resolve(ROOT, 'runs', args.a),
      b: resolve(ROOT, 'runs', args.b),
    })
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, result.markdown, 'utf-8')
    console.log(`report: ${out}`)
    process.exit(result.defects.total > 0 ? 1 : 0)
  } catch (err) {
    console.error(`compare: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
