import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineTool, getVariable, setVariable, withItem, withMeta } from '@mt/core'
import type { Exchange, ExchangeMeta, ToolContext } from '@mt/core'

import {
  type BatchEntry,
  createBatchApply,
  createBatchCollect,
  createEntryPacketParser,
  createEntryTranslator,
  findMemberEntry,
} from './batch-packet.js'
import { readDoc } from './schema-doc.js'

/**
 * Title packets — one configuration of the generic batch-package pipeline in `batch-packet.ts`:
 * collect the members' titles, translate the package as one item, parse the packet back, and
 * patch each chapter after `.unbatch()`. All machinery is generic; only the `read`/`keyOf`/
 * `translate`/`apply` fns below are title-specific.
 *
 * A package is the envelope produced by `.batch(n)` / `.window(n)`: `item` is `items[]` and the
 * member envelopes ride along in the ephemeral `batchMembers` variable. These tools read either
 * a package (all member titles in one shot) or a single chapter, and never touch the member
 * documents — so `.unbatch()` after the translation still restores the original chapters with
 * their `meta.chapterNum` and per-item variables.
 */

/** One chapter title extracted from a schema doc. */
export interface ChapterTitle {
  chapter: number
  title: string
}

const DEFAULT_SCHEMA_DIR = 'chapters/schema'
const HEADING_FILE_RE = /^chapter(\d+)(?:\.schema)?\.md$/i

export interface SchemaTitlesOptions {
  /** Project-relative directory holding `chapter<N>.schema.md`. Default `chapters/schema`. */
  schemaDir?: string
  /** Fall back to the chapter H1 when no schema doc is readable. Default `true`. */
  fallbackToHeading?: boolean
}

function chapterNumberOf(
  meta: ExchangeMeta | undefined,
  filePath: unknown,
  fallback: number,
): number {
  const explicit = meta?.chapterNum ?? meta?.chapter
  if (typeof explicit === 'number' && Number.isInteger(explicit)) return explicit
  if (typeof filePath === 'string') {
    const match = basename(filePath).match(HEADING_FILE_RE)
    const group = match?.[1]
    if (group) {
      const parsed = Number.parseInt(group, 10)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return fallback
}

/** First `# ` heading of a markdown string (frontmatter is skipped by callers that parse docs). */
function headingOf(item: unknown): string | undefined {
  if (typeof item !== 'string') return undefined
  for (const line of item.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return undefined
}

async function readSchemaTitle(
  root: string,
  schemaDir: string,
  chapter: number,
  logger: ToolContext['run']['logger'],
): Promise<string | undefined> {
  const filePath = join(root, schemaDir, `chapter${chapter}.schema.md`)
  try {
    const doc = readDoc(await readFile(filePath, 'utf-8'))
    return doc.title || undefined
  } catch (error) {
    logger.debug(`schema-titles: no readable schema doc at ${filePath}: ${String(error)}`)
    return undefined
  }
}

/** Map generic `BatchEntry[]` back to the title-specific `ChapterTitle[]` payload. */
function toChapterTitles(entries: BatchEntry[]): ChapterTitle[] {
  return entries.map((entry) => ({ chapter: Number(entry.key), title: entry.value }))
}

/** Map a `ChapterTitle[]` payload (or single title) into generic entries. */
function toBatchEntries(titles: ChapterTitle[] | ChapterTitle): BatchEntry[] {
  return (Array.isArray(titles) ? titles : [titles]).map((title) => ({
    key: String(title.chapter),
    value: title.title,
  }))
}

/**
 * Collect `{ chapter, title }` for every member of a package, reading each title from the
 * chapter's schema doc (`<schemaDir>/chapter<N>.schema.md`, parsed with `readDoc`).
 * The package payload becomes `ChapterTitle[]`; the `titles` variable mirrors it. A plain
 * (non-batch) envelope becomes a one-entry package.
 */
export function createSchemaTitles(options: SchemaTitlesOptions = {}) {
  const schemaDir = options.schemaDir ?? DEFAULT_SCHEMA_DIR
  const fallbackToHeading = options.fallbackToHeading ?? true
  const collect = createBatchCollect({
    keyOf: (member, index) =>
      String(chapterNumberOf(member.meta, member.meta?.filePath, index + 1)),
    read: async (member, index, ctx) => {
      const chapter = chapterNumberOf(member.meta, member.meta?.filePath, index + 1)
      return (
        (await readSchemaTitle(ctx.run.global.project.root, schemaDir, chapter, ctx.run.logger)) ??
        (fallbackToHeading ? headingOf(member.item) : undefined) ??
        `Chapter ${chapter}`
      )
    },
    variable: 'titles',
  })
  return defineTool<unknown, ChapterTitle[]>({
    name: 'schema-titles',
    version: '1.0.0',
    mdDescription:
      'Batch-aware: reads `{ chapter, title }` for each member from its schema doc ' +
      '(`chapter<N>.schema.md`). Emits a package payload `ChapterTitle[]` and sets `titles`.',
    async invoke(env: Exchange<unknown>, ctx: ToolContext): Promise<Exchange<ChapterTitle[]>> {
      const collected = await collect.invoke(env, ctx)
      const titles = toChapterTitles(collected.item)
      const packaged = withItem(collected, titles)
      return setVariable(
        collected.items === undefined
          ? packaged
          : { ...packaged, items: titles as unknown as ChapterTitle[][] },
        'titles',
        titles,
      )
    },
  })
}

const WORD_RE = /\p{L}+(?:['’]\p{L}+)?/gu

/** Deterministic word-level dictionary translation (no LLM, no network). */
export function dictionaryTranslateTitle(text: string, dictionary: Record<string, string>): string {
  return text
    .replace(WORD_RE, (word) => dictionary[word.toLowerCase()] ?? word)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([:,.;!?])/g, '$1')
    .trim()
}

export interface DictionaryTitleTranslatorOptions {
  /** Lower-case word → replacement. Unmatched words are kept verbatim. */
  dictionary: Record<string, string>
  /** Chapter/title separator in the packet. Default: a tab. */
  separator?: string
}

/**
 * Non-LLM title translator: takes a `ChapterTitle[]` package and emits one plain-text packet
 * (`<chapter><sep><translated title>` per line) in `item` + the `titlePacket` variable.
 * The packet is intentionally "dumb" — `titlePacketParser` turns it back into objects.
 */
export function createDictionaryTitleTranslator(options: DictionaryTitleTranslatorOptions) {
  const translate = createEntryTranslator({
    translate: (title) => dictionaryTranslateTitle(title, options.dictionary),
    separator: options.separator,
    variable: 'titlePacket',
  })
  return defineTool<ChapterTitle[] | ChapterTitle, string>({
    name: 'dictionary-title-translator',
    version: '1.0.0',
    mdDescription:
      'Deterministic dictionary translation of chapter titles into a `<chapter><sep><title>` ' +
      'packet (no LLM). Sets the `titlePacket` variable.',
    async invoke(
      env: Exchange<ChapterTitle[] | ChapterTitle>,
      ctx: ToolContext,
    ): Promise<Exchange<string>> {
      return translate.invoke(withItem(env, toBatchEntries(env.item)), ctx)
    },
  })
}

export interface TitlePacketParserOptions {
  /** Separator written by the translator. Default: a tab. */
  separator?: string
}

/**
 * Parse a title packet (`<chapter><sep><title>` lines) back into `ChapterTitle[]`, stored in
 * `item` and the `translatedTitles` variable. Malformed lines fail fast, naming the line.
 */
export function createTitlePacketParser(options: TitlePacketParserOptions = {}) {
  const parse = createEntryPacketParser({
    separator: options.separator,
    variable: 'translatedTitles',
  })
  return defineTool<string, ChapterTitle[]>({
    name: 'title-packet-parser',
    version: '1.0.0',
    mdDescription:
      'Parses a `<chapter><sep><title>` packet into `ChapterTitle[]` (`item` + `translatedTitles`).',
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<ChapterTitle[]>> {
      const parsed = await parse.invoke(env, ctx)
      const titles = toChapterTitles(parsed.item)
      if (titles.some((title) => !Number.isInteger(title.chapter))) {
        throw new Error('title-packet-parser: chapter key must be an integer')
      }
      const packaged = withItem(parsed, titles)
      return setVariable(
        parsed.items === undefined
          ? packaged
          : { ...packaged, items: titles as unknown as ChapterTitle[][] },
        'translatedTitles',
        titles,
      )
    },
  })
}

function replaceHeading(text: string, title: string): string {
  const lines = text.split('\n')
  let inFrontmatter = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (index === 0 && line.trim() === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false
      continue
    }
    if (line.trim().startsWith('# ')) {
      lines[index] = `# ${title}`
      return lines.join('\n')
    }
  }
  return `# ${title}\n\n${text}`
}

export interface ApplyTranslatedTitleOptions {
  /** `meta.lang` stamped on the output, e.g. `ru` → `chapter-output://` writes `chapters/ru/`. */
  lang?: string
  /** Variable holding the parsed `ChapterTitle[]`. Default `translatedTitles`. */
  entriesVariable?: string
}

/**
 * Per-item step (run after `.unbatch()`): replaces the chapter's H1 with its translated title,
 * picked from the batch-level `translatedTitles` variable by `meta.chapterNum` (falling back to
 * `meta.batchIndex`), and stamps `meta.lang` so a `chapter-output://` target writes the
 * translated chapter into its language folder.
 */
export function createApplyTranslatedTitle(options: ApplyTranslatedTitleOptions = {}) {
  const lang = options.lang ?? 'ru'
  const variable = options.entriesVariable ?? 'translatedTitles'
  const keyOf = (member: Exchange<unknown>): string => {
    const chapter = chapterNumberOf(member.meta, member.meta?.filePath, 0)
    return chapter > 0 ? String(chapter) : ''
  }
  const apply = createBatchApply({
    variable,
    byIndex: true,
    keyOf,
    apply: (member, entry) => {
      const text = replaceHeading(String(member.item), entry.value)
      return withMeta(withItem(member, text), { ...member.meta, lang })
    },
  })
  return defineTool<string, string>({
    name: 'apply-translated-title',
    version: '1.0.0',
    mdDescription:
      'Per-item: replaces the H1 with the translated title from `translatedTitles` (matched by ' +
      '`meta.chapterNum`) and sets `meta.lang` for `chapter-output://`.',
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      // Members restored by `.unbatch()` may carry either the parsed `ChapterTitle[]` (from
      // `titlePacketParser`) or the collected `titles`; normalize either into generic entries.
      const raw =
        getVariable<ChapterTitle[]>(env, variable) ?? getVariable<ChapterTitle[]>(env, 'titles')
      if (!Array.isArray(raw) || raw.length === 0) return env
      const entries = toBatchEntries(raw as ChapterTitle[])
      if (!findMemberEntry(env, entries, { keyOf, byIndex: true })) return env
      // Restore the title-shaped payload the variable advertised before the generic apply ran.
      const patched = (await apply.invoke(
        setVariable(env, variable, entries),
        ctx,
      )) as Exchange<string>
      return setVariable(patched, variable, raw)
    },
  })
}
