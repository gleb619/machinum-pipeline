/**
 * Pin the extracted glossary to the editorial names table.
 *
 * `pipelines/stages/glossary.ts` proposes terms but leaves `ru` empty and also proposes non-names
 * (`March`, `Lock`, `He's`). This pass makes the proposal usable:
 *
 *   - every table name gets its `ru`/`type` written;
 *   - a possessive (`Nadia's`, `Nadia’s`) takes the table's `gen` (fallback `ru`);
 *   - a table name the extractor missed is added (`count: 0`, `firstChapter: null`);
 *   - every term that does not resolve is marked `ignored: true`.
 *
 *   tsx scripts/apply-names.ts                 # chapters/glossary.json + chapters/names.json
 *   tsx scripts/apply-names.ts --dry-run       # print the rewrites, write nothing
 *   tsx scripts/apply-names.ts --glossary g.json --names n.json
 *
 * Idempotent: a second run finds nothing to change and leaves the file untouched. The write is
 * atomic (temp file then rename) because a half-written glossary breaks every later pipeline.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ApplyNamesOptions {
  glossaryPath: string
  namesPath: string
  dryRun?: boolean
  log?: (line: string) => void
}

export interface ApplyNamesResult {
  /** Existing terms whose `ru`/`type` were written (or whose stale `ignored` was cleared). */
  rewritten: number
  /** Terms marked `ignored: true` because the table does not know them. */
  ignored: number
  /** Table names created because the extractor missed them. */
  added: number
  /** Unique table names applied (already present or created); stable across re-runs. */
  applied: number
  /** `false` when the run was a no-op (idempotent second run). */
  changed: boolean
}

interface GlossaryTerm {
  term: string
  id?: string
  type?: string
  ru?: string | null
  ignored?: boolean
  [key: string]: unknown
}

interface GlossaryFile {
  terms: GlossaryTerm[]
  ignored?: string[]
  rejected?: string[]
  [key: string]: unknown
}

interface TableName {
  ru: string
  gen: string
  type: string
}

interface Resolution {
  /** Table key the term resolved to (`Nadia` for `Nadia's`). */
  key: string
  ru: string
  type: string
}

/** `people`/`places`/`things` with the glossary type used when an entry omits `type`. */
const NAME_SECTIONS = [
  ['people', 'character'],
  ['places', 'place'],
  ['things', 'item'],
] as const

const TRAILING_PUNCTUATION = /[.,;:]+$/u
const POSSESSIVE = /^(.+?)['’]s$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readJson(path: string, kind: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error(`${kind} file not found: ${path}`, { cause: err })
    }
    throw new Error(`failed to read ${kind} ${path}: ${messageOf(err)}`, { cause: err })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`failed to parse ${kind} ${path}: ${messageOf(err)}`, { cause: err })
  }
}

async function loadGlossary(path: string): Promise<GlossaryFile> {
  const raw = await readJson(path, 'glossary')
  if (!isRecord(raw) || !Array.isArray(raw.terms)) {
    throw new Error(`failed to parse glossary ${path}: expected an object with a "terms" array`)
  }
  const terms: GlossaryTerm[] = []
  for (const [index, entry] of raw.terms.entries()) {
    if (!isRecord(entry) || typeof entry.term !== 'string') {
      throw new Error(`failed to parse glossary ${path}: term ${index} has no "term" string`)
    }
    terms.push(entry as GlossaryTerm)
  }
  return { ...raw, terms }
}

async function loadTable(path: string): Promise<Map<string, TableName>> {
  const raw = await readJson(path, 'names')
  if (!isRecord(raw)) {
    throw new Error(`failed to parse names ${path}: expected an object`)
  }
  const table = new Map<string, TableName>()
  for (const [section, fallbackType] of NAME_SECTIONS) {
    const group = raw[section]
    if (group === undefined) continue
    if (!isRecord(group)) {
      throw new Error(`failed to parse names ${path}: "${section}" must be an object`)
    }
    for (const [name, entry] of Object.entries(group)) {
      if (name.startsWith('_')) continue
      if (!isRecord(entry)) {
        throw new Error(`failed to parse names ${path}: "${section}.${name}" must be an object`)
      }
      const ru = entry.ru
      if (typeof ru !== 'string' || ru.trim() === '') {
        throw new Error(`failed to parse names ${path}: "${section}.${name}" has no "ru" string`)
      }
      const genValue = entry.gen
      const gen = typeof genValue === 'string' && genValue.trim() !== '' ? genValue : ru
      const typeValue = entry.type
      const type =
        typeof typeValue === 'string' && typeValue.trim() !== '' ? typeValue : fallbackType
      if (!table.has(name)) table.set(name, { ru, gen, type })
    }
  }
  return table
}

/** Exact table match first, then a possessive taking the table's genitive. */
function resolveTerm(term: string, table: Map<string, TableName>): Resolution | undefined {
  const surface = term.trim().replace(TRAILING_PUNCTUATION, '')
  const exact = table.get(surface)
  if (exact) return { key: surface, ru: exact.ru, type: exact.type }

  const possessive = POSSESSIVE.exec(surface)
  const base = possessive?.[1]?.trim()
  if (base === undefined) return undefined
  const entry = table.get(base)
  if (entry) return { key: base, ru: entry.gen, type: entry.type }
  return undefined
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'term' : slug
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  let suffix = 2
  while (taken.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  taken.add(id)
  return id
}

/**
 * Rewrite `glossaryPath` against `namesPath`. Mutates nothing when `dryRun` is set; the result
 * still reports what would have changed.
 */
export async function applyNames(options: ApplyNamesOptions): Promise<ApplyNamesResult> {
  const glossaryPath = resolve(options.glossaryPath)
  const namesPath = resolve(options.namesPath)
  const dryRun = options.dryRun === true
  const log = options.log ?? ((line: string) => console.log(line))

  const table = await loadTable(namesPath)
  const glossary = await loadGlossary(glossaryPath)
  const terms = glossary.terms
  const taken = new Set<string>()
  for (const term of terms) {
    if (typeof term.id === 'string' && term.id !== '') taken.add(term.id)
  }

  let rewritten = 0
  let ignored = 0
  let added = 0
  const represented = new Set<string>()

  for (const term of terms) {
    const resolution = resolveTerm(term.term, table)
    if (resolution) {
      represented.add(resolution.key)
      const wasIgnored = term.ignored === true
      if (term.ru === resolution.ru && term.type === resolution.type && !wasIgnored) continue
      term.ru = resolution.ru
      term.type = resolution.type
      if (wasIgnored) term.ignored = false
      rewritten += 1
      log(`rewrite ${term.term} -> ${resolution.ru} (${resolution.type})`)
      continue
    }
    if (term.ignored === true) continue
    term.ignored = true
    ignored += 1
    log(`ignore ${term.term}`)
  }

  for (const [name, entry] of table) {
    if (represented.has(name)) continue
    terms.push({
      id: uniqueId(slugify(name), taken),
      term: name,
      type: entry.type,
      count: 0,
      firstChapter: null,
      ru: entry.ru,
      aliases: [],
      references: [],
    })
    added += 1
    log(`add ${name} -> ${entry.ru} (${entry.type})`)
  }

  const changed = rewritten + ignored + added > 0
  if (changed && !dryRun) {
    const tmp = `${glossaryPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(glossary, null, 2)}\n`, 'utf-8')
    await rename(tmp, glossaryPath)
  }

  const applied = represented.size + added
  const suffix = dryRun ? ' (dry run: nothing written)' : ''
  log(`apply-names: ${rewritten} rewritten, ${ignored} ignored, ${added} added${suffix}`)
  return { rewritten, ignored, added, applied, changed }
}

interface CliArgs {
  glossaryPath: string
  namesPath: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let glossaryPath = 'chapters/glossary.json'
  let namesPath = 'chapters/names.json'
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--glossary') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--glossary needs a path')
      glossaryPath = value
    } else if (arg === '--names') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--names needs a path')
      namesPath = value
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg !== undefined && !arg.startsWith('-')) {
      throw new Error(`unexpected argument '${arg}'`)
    }
  }
  return { glossaryPath, namesPath, dryRun }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await applyNames(parseArgs(process.argv.slice(2)))
  } catch (err) {
    console.error(`apply-names: ${messageOf(err)}`)
    process.exit(1)
  }
}
