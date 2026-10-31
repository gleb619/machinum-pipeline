import { batchMembersOf, defineTool, getVariable, setVariable, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/**
 * Generic batch-package pipeline: collect one keyed value per member of a `.batch()` /
 * `.window()` package, transform the package as one item, serialize it to a plain-text packet,
 * parse the packet back, and — after `.unbatch()` — patch each value into its member again.
 *
 * Nothing here knows about titles, chapters or any domain: `read`, `keyOf`, `translate` and
 * `apply` are caller-supplied. The title flow in `title-packet.ts` is one configuration of
 * these pieces; a paragraph, summary or any other per-member field is another.
 */

/** One keyed value collected from (or patched back into) a batch member. */
export interface BatchEntry {
  /** Stable member key — a chapter number, a paragraph id, anything `keyOf` mints. */
  key: string
  value: string
}

const DEFAULT_ENTRY_VARIABLE = 'entries'
const DEFAULT_PACKET_VARIABLE = 'packet'

function memberKey(member: Exchange<unknown>, index: number): string {
  const batchIndex = member.meta?.batchIndex
  return typeof batchIndex === 'number' ? String(batchIndex) : String(index)
}

/** A folded package keeps `items` identical to `item`, while `Exchange<T>.items` models a
 * per-member list (`T[]` of `T[]`) — hence the cast, shared by every packet tool below. */
function withPackageItems<I, O>(env: Exchange<I>, item: O, entries: O): Exchange<O> {
  const next = withItem(env, item)
  return env.items === undefined ? next : { ...next, items: entries as unknown as O[] }
}

export interface BatchCollectOptions {
  /** Read the raw value for one member; `undefined` falls back to {@link fallback}. */
  read: (
    member: Exchange<unknown>,
    index: number,
    ctx: ToolContext,
  ) => Promise<string | undefined> | string | undefined
  /** Stable entry key for a member. Default: `meta.batchIndex`, else the position. */
  keyOf?: (member: Exchange<unknown>, index: number) => string
  /** Value used when `read` returns `undefined`. Default: `''`. */
  fallback?: (member: Exchange<unknown>, index: number) => Promise<string> | string
  /** Variable name for the collected entries. Default `entries`. */
  variable?: string
}

/**
 * Collect `{ key, value }` for every member of a package (a plain envelope counts as a
 * one-member package). The package payload becomes `BatchEntry[]`, mirrored into `items`, and
 * is stored in the configured variable (default `entries`) so later stages — including members
 * restored by `.unbatch()` — can reach it.
 */
export function createBatchCollect(options: BatchCollectOptions) {
  const variable = options.variable ?? DEFAULT_ENTRY_VARIABLE
  return defineTool<unknown, BatchEntry[]>({
    name: 'batch-collect',
    version: '1.0.0',
    mdDescription:
      'Batch-aware: collects one `{ key, value }` entry per package member via the supplied ' +
      '`read` fn. Payload `BatchEntry[]` + variable (default `entries`).',
    async invoke(env: Exchange<unknown>, ctx: ToolContext): Promise<Exchange<BatchEntry[]>> {
      const members = batchMembersOf(env) ?? [env]
      const entries: BatchEntry[] = []
      for (let index = 0; index < members.length; index++) {
        const member = members[index]
        if (!member) continue
        const key = options.keyOf ? options.keyOf(member, index) : memberKey(member, index)
        const raw = await options.read(member, index, ctx)
        const value =
          raw !== undefined ? raw : options.fallback ? await options.fallback(member, index) : ''
        entries.push({ key, value })
      }
      const packaged = withPackageItems(env, entries, entries)
      return setVariable(packaged, variable, entries)
    },
  })
}

export interface EntryTranslatorOptions {
  /** Transform one entry value. Default: identity. */
  translate?: (value: string, key: string) => Promise<string> | string
  /** Separator between key and value in the packet. Default: a tab. */
  separator?: string
  /** Variable name for the packet text. Default `packet`. */
  variable?: string
}

/**
 * Package-as-one-item step: serialize `BatchEntry[]` into one plain-text packet
 * (`<key><sep><value>` per line) in `item` + the configured variable (default `packet`).
 * The packet is intentionally "dumb" — `createEntryPacketParser` turns it back into objects.
 */
export function createEntryTranslator(options: EntryTranslatorOptions = {}) {
  const separator = options.separator ?? '\t'
  const variable = options.variable ?? DEFAULT_PACKET_VARIABLE
  return defineTool<BatchEntry[] | BatchEntry, string>({
    name: 'entry-translator',
    version: '1.0.0',
    mdDescription:
      'Serializes `BatchEntry[]` into a `<key><sep><value>` packet (one line per entry) via the ' +
      'supplied `translate` fn. Sets the packet variable (default `packet`).',
    async invoke(env: Exchange<BatchEntry[] | BatchEntry>): Promise<Exchange<string>> {
      const entries = Array.isArray(env.item) ? env.item : [env.item]
      const lines: string[] = []
      for (const entry of entries) {
        const value = options.translate
          ? await options.translate(entry.value, entry.key)
          : entry.value
        lines.push(`${entry.key}${separator}${value}`)
      }
      const packet = lines.join('\n')
      return setVariable(withItem(env, packet), variable, packet)
    },
  })
}

export interface EntryPacketParserOptions {
  /** Separator written by the translator. Default: a tab. */
  separator?: string
  /** Variable name for the parsed entries. Default `entries`. */
  variable?: string
}

/**
 * Parse a `<key><sep><value>` packet back into `BatchEntry[]` (`item` + the configured
 * variable, default `entries`). Malformed lines fail fast, naming the line.
 */
export function createEntryPacketParser(options: EntryPacketParserOptions = {}) {
  const separator = options.separator ?? '\t'
  const variable = options.variable ?? DEFAULT_ENTRY_VARIABLE
  return defineTool<string, BatchEntry[]>({
    name: 'entry-packet-parser',
    version: '1.0.0',
    mdDescription:
      'Parses a `<key><sep><value>` packet into `BatchEntry[]` (`item` + variable, default ' +
      '`entries`). Malformed lines fail fast.',
    async invoke(env: Exchange<string>): Promise<Exchange<BatchEntry[]>> {
      const text = typeof env.item === 'string' ? env.item : String(env.item)
      const entries: BatchEntry[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]?.trim()
        if (!line) continue
        const at = line.indexOf(separator)
        if (at <= 0) {
          throw new Error(
            `entry-packet-parser: line ${index + 1} is not '<key>${separator}<value>': ${line}`,
          )
        }
        const key = line.slice(0, at).trim()
        const value = line.slice(at + separator.length).trim()
        if (key.length === 0 || value.length === 0) {
          throw new Error(
            `entry-packet-parser: line ${index + 1} has an empty key or value: ${line}`,
          )
        }
        entries.push({ key, value })
      }
      const packaged = withPackageItems(env, entries, entries)
      return setVariable(packaged, variable, entries)
    },
  })
}

export interface BatchApplyOptions {
  /** Patch one member with its entry value; returns the next member exchange. */
  apply: (
    member: Exchange<unknown>,
    entry: BatchEntry,
  ) => Exchange<unknown> | Promise<Exchange<unknown>>
  /** Entry key for a member. Default: `String(meta.batchIndex)`, else `''` (no match). */
  keyOf?: (member: Exchange<unknown>) => string
  /** Positional fallback via `meta.batchIndex` when `keyOf` finds no matching entry. */
  byIndex?: boolean
  /** Variable holding the parsed entries. Default `entries`. */
  variable?: string
}

/** Entry lookup shared by {@link createBatchApply} and wrapper tools that pre-check matches. */
export function findMemberEntry(
  member: Exchange<unknown>,
  entries: BatchEntry[],
  options: Pick<BatchApplyOptions, 'keyOf' | 'byIndex'> = {},
): BatchEntry | undefined {
  const key = options.keyOf ? options.keyOf(member) : memberKey(member, 0)
  const entry = key ? entries.find((candidate) => candidate.key === key) : undefined
  if (entry) return entry
  if (options.byIndex) {
    const batchIndex = member.meta?.batchIndex
    if (typeof batchIndex === 'number') return entries[batchIndex]
  }
  return undefined
}

/**
 * Per-member step (run after `.unbatch()`): find the entry for this member via `keyOf`
 * (falling back positionally to `meta.batchIndex` when {@link BatchApplyOptions.byIndex}) and
 * patch it in with the supplied `apply` fn. Members without a matching entry pass through.
 */
export function createBatchApply(options: BatchApplyOptions) {
  const variable = options.variable ?? DEFAULT_ENTRY_VARIABLE
  return defineTool<unknown, unknown>({
    name: 'batch-apply',
    version: '1.0.0',
    mdDescription:
      'Per-item (after `.unbatch()`): patches the member with its entry from the entries ' +
      'variable via the supplied `apply` fn; unmatched members pass through.',
    async invoke(env: Exchange<unknown>): Promise<Exchange<unknown>> {
      const raw = getVariable<BatchEntry[]>(env, variable)
      const entries = Array.isArray(raw) ? raw : []
      if (entries.length === 0) return env
      const entry = findMemberEntry(env, entries, options)
      if (!entry) return env
      return await options.apply(env, entry)
    },
  })
}
