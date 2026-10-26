/**
 * Exchange - the unit of data flowing through a pipeline (Camel-style).
 *
 * An Exchange carries the payload, identity-ish `meta`, and a list of named `variables` with
 * qualifiers (`new | old | copy | alt`). Modeled on the Java `FlowContext` / `FlowArgument` pair.
 *
 * The payload is itself a variable: the `item` variable ({@link ITEM_VARIABLE}, qualifier `new`) is
 * the single source of truth, so it gets the same history as any other variable (`withItem` keeps
 * the previous payload as the `old` item variable, see {@link oldItemOf}). `Exchange.item` is a
 * materialized convenience copy of that variable, kept in sync by every helper in this file;
 * on disagreement the variable wins when rebuilding ({@link fromPersisted}, {@link itemOf}); a
 * loose input literal whose `item` field differs from its variable (`{ ...env, item: x }`) is
 * normalized by {@link toExchange} as a payload edit (pushed like {@link withItem}).
 * The batch/window payload list stays the plain `items` field ({@link itemsOf}).
 *
 * An Exchange is a plain JSON-serializable object (checkpoints, events.jsonl and dead-letter
 * `JSON.stringify` it). All operations here are pure free functions returning a NEW exchange.
 */

/** Variable qualifier: `new` current value, `old` previous value kept by `push`, `copy`, `alt` alternative. */
export type Qualifier = 'new' | 'old' | 'copy' | 'alt'

/** A named value attached to an Exchange. */
export interface Variable<U = unknown> {
  id: string
  name: string
  qualifier: Qualifier
  value: U
  /** ISO timestamp of creation. */
  timestamp: string
  /** Ephemeral variables are dropped by `withoutEphemeral` and excluded from cache hashes. */
  ephemeral: boolean
}

/** Identity metadata. Keep to ids; use variables for data. */
export interface ExchangeMeta {
  chapterId?: string
  paragraphId?: string
  lineId?: string
  [k: string]: unknown
}

/** Full exchange: the engine always sees this shape. */
export interface Exchange<T = unknown> {
  id: string
  /** Materialized copy of the `item` variable (see {@link ITEM_VARIABLE}); read via {@link itemOf}. */
  item: T
  /** Batch/window payload list (the `item` is the same array); read via {@link itemsOf}. */
  items?: T[]
  /**
   * In-flight identity data ONLY. Never persisted: dead-letter entries and jsonl targets drop it
   * (see {@link toPersisted}), and a resumed run re-derives it from the Source. Anything that must
   * survive pause/resume/dead-letter belongs in {@link Exchange.variables}.
   */
  meta: ExchangeMeta
  /**
   * Durable named values with qualifiers. Persisted (id, name, qualifier, value, timestamp) in
   * dead-letter entries and jsonl targets, except `ephemeral` ones, which are in-flight only and
   * dropped on persist.
   */
  variables: Variable[]
}

/** Name of the variable carrying the payload (qualifier `new`; previous payload is `old`). */
export const ITEM_VARIABLE = 'item'

/**
 * Persisted form of an Exchange: no `meta`, no ephemeral variables, and NO separate `item` field -
 * the payload lives only in the `item` variable.
 */
export interface PersistedExchange {
  id: string
  items?: unknown[]
  variables: Variable[]
}

/** Project an exchange to its persisted form: drops `meta`, `item` field and ephemeral variables. */
export function toPersisted<T>(ex: Exchange<T>): PersistedExchange {
  const out: PersistedExchange = {
    id: ex.id,
    variables: syncItem(ex).variables.filter((v) => !v.ephemeral),
  }
  if (ex.items !== undefined) out.items = ex.items
  return out
}

/**
 * Rehydrate a persisted exchange: `meta` comes back empty (re-derive it from the Source/ids) and
 * `item` is rebuilt from the `item` variable.
 */
export function fromPersisted<T = unknown>(p: PersistedExchange): Exchange<T> {
  const ex = syncItem({
    id: p.id,
    item: undefined as T,
    meta: {},
    variables: [...(p.variables ?? [])],
  } as Exchange<T>)
  if (p.items !== undefined) ex.items = p.items as T[]
  return ex
}

/**
 * Loose input shape accepted from Sources / flatMap / literals: `id` and `variables` optional.
 * Normalized by {@link toExchange}.
 */
export interface ExchangeInput<T = unknown> {
  id?: string
  item: T
  items?: T[]
  meta?: ExchangeMeta
  variables?: Variable[]
}

let idCounter = 0

/** Mint a fresh process-unique id with the given prefix. */
export function newExchangeId(prefix = 'ex-'): string {
  idCounter += 1
  return `${prefix}${idCounter}`
}

/** Rules (same as Java `FlowArgument.isEmpty`): null/undefined, blank string, empty array. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

export interface VariableOptions {
  qualifier?: Qualifier
  ephemeral?: boolean
  id?: string
  timestamp?: string
}

/** Build a Variable (qualifier defaults to `new`). */
export function variable<U>(name: string, value: U, opts: VariableOptions = {}): Variable<U> {
  return {
    id: opts.id ?? newExchangeId('var-'),
    name,
    qualifier: opts.qualifier ?? 'new',
    value,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    ephemeral: opts.ephemeral ?? false,
  }
}

/** Create a full Exchange from a payload. */
export function createExchange<T>(
  item: T,
  init: { id?: string; meta?: ExchangeMeta; variables?: Variable[]; items?: T[] } = {},
): Exchange<T> {
  const vars = (init.variables ?? []).filter((v) => !isNewItem(v))
  const ex: Exchange<T> = {
    id: init.id ?? newExchangeId(),
    item,
    meta: { ...(init.meta ?? {}) },
    variables: [...vars, variable(ITEM_VARIABLE, item)],
  }
  if (init.items !== undefined) ex.items = init.items
  return ex
}

function isNewItem(v: Variable): boolean {
  return v.name === ITEM_VARIABLE && v.qualifier === 'new'
}

/**
 * Make `item` agree with the `new` item variable (the variable wins). When the variable is absent
 * it is created from `ex.item`. Returns the same object when already in sync.
 */
function syncItem<T>(ex: Exchange<T>): Exchange<T> {
  const vars = varsOf(ex)
  const cur = vars.find(isNewItem)
  if (!cur) {
    return { ...ex, variables: [...vars, variable(ITEM_VARIABLE, ex.item)] }
  }
  if (Object.is(cur.value, ex.item)) return ex
  return { ...ex, item: cur.value as T, variables: vars }
}

/** Payload of an exchange (the `new` `item` variable). */
export function itemOf<T>(ex: Exchange<T>): T {
  return syncItem(ex).item
}

/** Previous payload kept by {@link withItem} (the `old` `item` variable); `undefined` if none. */
export function oldItemOf<T = unknown>(ex: Pick<Exchange, 'variables'>): T | undefined {
  return getVariable<T>(ex, ITEM_VARIABLE, 'old')
}

/** Batch/window payload list; `[item]` for a plain single-item exchange. */
export function itemsOf<T>(ex: Exchange<T>): T[] {
  return ex.items ?? [itemOf(ex)]
}

/**
 * Normalize loose input into a full Exchange. Existing object is reused when already complete
 * (no copy); otherwise a shallow copy with `id` / `meta` / `variables` filled in.
 */
export function toExchange<T>(input: ExchangeInput<T> | Exchange<T>): Exchange<T> {
  const full: Exchange<T> =
    input.id !== undefined && input.meta !== undefined && input.variables !== undefined
      ? (input as Exchange<T>)
      : {
          ...input,
          id: input.id ?? newExchangeId(),
          item: input.item,
          meta: input.meta ?? {},
          variables: input.variables ?? [],
        }
  const cur = full.variables.find(isNewItem)
  if (!cur) return addItemVariable(full)
  if (Object.is(cur.value, full.item) || full.item === undefined) return syncItem(full)
  // A literal such as `{ ...env, item: next }` edited the payload field of an exchange that
  // already has an `item` variable: treat the field as the new payload (pushed, history kept).
  const pushed = pushVariable(full, ITEM_VARIABLE, full.item)
  return full.items !== undefined ? { ...pushed, items: full.items } : pushed
}

function addItemVariable<T>(ex: Exchange<T>): Exchange<T> {
  return { ...ex, variables: [...ex.variables, variable(ITEM_VARIABLE, ex.item)] }
}

/**
 * Derive an exchange with a new payload; id/meta/variables propagate. Clears `items`. The previous
 * payload is kept as the `old` item variable (see {@link oldItemOf}).
 */
export function withItem<I, O>(ex: Exchange<I>, item: O): Exchange<O> {
  const { items: _items, ...rest } = syncItem(ex)
  return pushVariable(rest as unknown as Exchange<O>, ITEM_VARIABLE, item)
}

/** Derive an exchange with `meta` merged in. */
export function withMeta<T>(ex: Exchange<T>, meta: ExchangeMeta): Exchange<T> {
  return { ...ex, meta: { ...ex.meta, ...meta } }
}

/** Find a variable by name + qualifier (default `new`). */
export function findVariable<U = unknown>(
  ex: Pick<Exchange, 'variables'>,
  name: string,
  qualifier: Qualifier = 'new',
): Variable<U> | undefined {
  // `variables` may be absent on hand-built literals handed straight to a Target/Tool in tests.
  return varsOf(ex).find((v) => v.name === name && v.qualifier === qualifier) as
    | Variable<U>
    | undefined
}

/** Value of a `new` variable (or given qualifier); `undefined` when absent. */
export function getVariable<U = unknown>(
  ex: Pick<Exchange, 'variables'>,
  name: string,
  qualifier: Qualifier = 'new',
): U | undefined {
  return findVariable<U>(ex, name, qualifier)?.value
}

/** Value of the `old` variable (previous value kept by `pushVariable`). */
export function getOldVariable<U = unknown>(
  ex: Pick<Exchange, 'variables'>,
  name: string,
): U | undefined {
  return getVariable<U>(ex, name, 'old')
}

export function hasVariable(
  ex: Pick<Exchange, 'variables'>,
  name: string,
  qualifier: Qualifier = 'new',
): boolean {
  return findVariable(ex, name, qualifier) !== undefined
}

/** Variables of an exchange, tolerating hand-built literals that omit them. */
function varsOf(ex: Pick<Exchange, 'variables'>): Variable[] {
  return ex.variables ?? []
}

function sameKey(a: Variable, b: Variable): boolean {
  return a.name === b.name && a.qualifier === b.qualifier
}

/** Add variables; an existing variable with the same name+qualifier is replaced. */
export function withVariable<T>(ex: Exchange<T>, ...vars: Variable[]): Exchange<T> {
  const kept = varsOf(ex).filter((v) => !vars.some((n) => sameKey(v, n)))
  const next = { ...ex, variables: [...kept, ...vars] }
  const item = vars.find(isNewItem)
  return item ? { ...next, item: item.value as T } : next
}

/** Shortcut: set a `new` variable by name/value. */
export function setVariable<T, U>(
  ex: Exchange<T>,
  name: string,
  value: U,
  opts: VariableOptions = {},
): Exchange<T> {
  return withVariable(ex, variable(name, value, opts))
}

/** Remove variables by name (all qualifiers), or one qualifier when given. */
export function withoutVariable<T>(
  ex: Exchange<T>,
  name: string,
  qualifier?: Qualifier,
): Exchange<T> {
  return {
    ...ex,
    variables: varsOf(ex).filter(
      (v) =>
        !(
          v.name === name &&
          (qualifier === undefined || v.qualifier === qualifier) &&
          // the payload variable cannot be removed, only replaced (withItem / pushVariable)
          !isNewItem(v)
        ),
    ),
  }
}

/**
 * Set several `new` variables at once (`undefined` values are skipped). Existing same-name `new`
 * variables are replaced. Convenience for tools that publish computed results.
 */
export function setVariables<T>(
  ex: Exchange<T>,
  values: Record<string, unknown>,
  opts: VariableOptions = {},
): Exchange<T> {
  const vars = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => variable(name, value, opts))
  return vars.length === 0 ? ex : withVariable(ex, ...vars)
}

/** Name of the variable carrying `MdOutputEntry[]` write intents for the `md://` target. */
export const MD_OUTPUTS_VARIABLE = 'mdOutputs'

/** Replace the `new` variable `name` with a new value, keeping no history. Adds when absent. */
export function replaceVariable<T, U>(ex: Exchange<T>, name: string, value: U): Exchange<T> {
  const cur = findVariable(ex, name)
  return withVariable(ex, variable(name, value, { ephemeral: cur?.ephemeral }))
}

/**
 * Push a new value: the current `new` variable becomes `old` (replacing any previous `old`), and a
 * `new` variable carries the value. Mirrors Java `FlowContext.push` / `rearrange`. An empty
 * previous value is not kept as `old`.
 */
export function pushVariable<T, U>(
  ex: Exchange<T>,
  name: string,
  value: U,
  opts: VariableOptions = {},
): Exchange<T> {
  const cur = findVariable(ex, name)
  const next = variable(name, value, opts)
  if (!cur) return withVariable(ex, next)
  const without = withoutVariable(ex, name, 'old')
  const old: Variable = isEmptyValue(cur.value)
    ? { ...cur, qualifier: 'old', value: null }
    : { ...cur, qualifier: 'old' }
  return withVariable(without, old, next)
}

/** Copy the `new` variable under qualifier `copy`, optionally mapping its value. */
export function copyVariable<T>(
  ex: Exchange<T>,
  name: string,
  map: (v: unknown) => unknown = (v) => v,
): Exchange<T> {
  const cur = findVariable(ex, name)
  if (!cur) return ex
  return withVariable(ex, {
    ...cur,
    id: newExchangeId('var-'),
    qualifier: 'copy',
    value: map(cur.value),
  })
}

/** Drop ephemeral variables. */
export function withoutEphemeral<T>(ex: Exchange<T>): Exchange<T> {
  return { ...ex, variables: varsOf(ex).filter((v) => !v.ephemeral || isNewItem(v)) }
}

/** Drop `old` and empty variables. */
export function withoutOldAndEmpty<T>(ex: Exchange<T>): Exchange<T> {
  return {
    ...ex,
    variables: varsOf(ex).filter(
      (v) => isNewItem(v) || (v.qualifier !== 'old' && !isEmptyValue(v.value)),
    ),
  }
}

/** Drop empty variables. */
export function withoutEmpty<T>(ex: Exchange<T>): Exchange<T> {
  return { ...ex, variables: varsOf(ex).filter((v) => isNewItem(v) || !isEmptyValue(v.value)) }
}

/**
 * Merge variables of several exchanges (later wins on name+qualifier clash). Used by batch/window.
 * The payload (`item` variables) is NOT merged: the caller builds the merged exchange's own.
 */
export function mergeVariables(exchanges: ReadonlyArray<Pick<Exchange, 'variables'>>): Variable[] {
  const out: Variable[] = []
  for (const e of exchanges) {
    for (const v of varsOf(e)) {
      if (v.name === ITEM_VARIABLE) continue
      const i = out.findIndex((o) => sameKey(o, v))
      if (i >= 0) out[i] = v
      else out.push(v)
    }
  }
  return out
}

/**
 * Stable view of the non-ephemeral variables for hashing (id/timestamp excluded). The payload
 * (`item` variables, incl. history) is excluded: hash it via the item value so equal payloads
 * hash equally regardless of how they were produced.
 */
export function hashableVariables(ex: Pick<Exchange, 'variables'>): unknown[] {
  return varsOf(ex)
    .filter((v) => !v.ephemeral && v.name !== ITEM_VARIABLE)
    .map((v) => ({ name: v.name, qualifier: v.qualifier, value: v.value }))
}
