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
 * The batch payload list stays the plain `items` field ({@link itemsOf}).
 *
 * An Exchange is a plain JSON-serializable object (checkpoints, events.jsonl and dead-letter
 * `JSON.stringify` it). All operations here are pure free functions returning a NEW exchange.
 */

import type {
  BatchMembers,
  Exchange,
  ExchangeInput,
  ExchangeMeta,
  PersistedExchange,
  Qualifier,
  Variable,
  VariableOptions,
} from './types/exchange.js'

export type {
  BatchMembers,
  Exchange,
  ExchangeInput,
  ExchangeMeta,
  PersistedExchange,
  Qualifier,
  Variable,
  VariableOptions,
} from './types/exchange.js'

/** Name of the variable carrying the payload (qualifier `new`; previous payload is `old`). */
export const ITEM_VARIABLE = 'item'

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
  // `unknown[]`, not `T[]`: a batch envelope's `item` is already the member array, and `T[]`
  // here would drag inference down to the element type (the classic batch envelope trap).
  init: { id?: string; meta?: ExchangeMeta; variables?: Variable[]; items?: unknown[] } = {},
): Exchange<T> {
  const vars = (init.variables ?? []).filter((v) => !isNewItem(v))
  const ex: Exchange<T> = {
    id: init.id ?? newExchangeId(),
    item,
    meta: { ...(init.meta ?? {}) },
    variables: [...vars, variable(ITEM_VARIABLE, item)],
  }
  if (init.items !== undefined) ex.items = init.items as T[]
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

/** Batch payload list; `[item]` for a plain single-item exchange. */
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
 * Name of the ephemeral variable carrying the member envelopes of a `.batch()` group. Ephemeral: it never reaches checkpoints, dead-letter entries or persisted jsonl, so a
 * resumed run re-forms the group from the source and re-runs its scope (see `batch-scope.ts`).
 */
export const BATCH_MEMBERS_VARIABLE = 'batchMembers'

/**
 * Payload of {@link BATCH_MEMBERS_VARIABLE}: the original member envelopes plus a snapshot of
 * the variables that were merged into the batch when it was created. The snapshot lets
 * {@link unbatchExchange} tell apart variables that existed before batching (already on the
 * members) from the ones a batch-aware tool changed since (which must be propagated back).
 */
export interface BatchMembers {
  members: Exchange<unknown>[]
  base: Variable[]
}

/**
 * Attach the source envelopes of a batch group to the merged batch exchange, so the batch scope
 * (`.batch(opts, nested)`) can restore each member with its own `meta` and variables. Used by
 * the Runner.
 */
export function withBatchMembers<T>(
  batch: Exchange<T[]>,
  group: ReadonlyArray<Exchange<T>>,
): Exchange<T[]> {
  const pack: BatchMembers = {
    members: group as Exchange<unknown>[],
    base: mergeVariables(group),
  }
  return withVariable(batch, variable(BATCH_MEMBERS_VARIABLE, pack, { ephemeral: true }))
}

/** Member envelopes carried by a batch exchange; `undefined` for plain envelopes. */
export function batchMembersOf<T = unknown>(
  ex: Pick<Exchange, 'variables'>,
): Exchange<T>[] | undefined {
  return getVariable<BatchMembers>(ex, BATCH_MEMBERS_VARIABLE)?.members as Exchange<T>[] | undefined
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Batch variables that changed after the group was folded (base snapshot excluded). */
function batchOverrides(ex: Exchange<unknown>, base: Variable[]): Variable[] {
  return ex.variables.filter((v) => {
    if (v.name === BATCH_MEMBERS_VARIABLE || isNewItem(v)) return false
    const previous = base.find((b) => sameKey(b, v))
    return !previous || !sameValue(previous.value, v.value)
  })
}

/**
 * Variables a group-level step edited since the group was folded, compared with the snapshot
 * carried by `folded` (the group as created by the Runner). Used by the batch scope's commit.
 */
export function groupVariableEdits(
  edited: Exchange<unknown>,
  folded: Exchange<unknown>,
): Variable[] {
  const pack = getVariable<BatchMembers>(folded, BATCH_MEMBERS_VARIABLE)
  return batchOverrides(edited, pack?.base ?? [])
}

/**
 * Internal inverse of `.batch()`: expand a grouped exchange back into its member
 * envelopes (the `batch://members` view of a batch scope). Not part of the DSL. Members keep their `id`, `meta` (plus `meta.batchIndex`) and their own variables;
 * variables a batch-aware tool set or changed since the group was folded are stamped onto every
 * member (the batch is the most recent stage, so its value wins). A group without carried
 * members (e.g. a source-level batch, or a batch reloaded from a checkpoint) falls back to
 * `itemsOf(ex)` with a generated id `<id>.<index>` and `meta.parentId`.
 */
export function unbatchExchange<T = unknown>(ex: Exchange<T>): Exchange<unknown>[] {
  const pack = getVariable<BatchMembers>(ex, BATCH_MEMBERS_VARIABLE)
  if (!pack || pack.members.length === 0) {
    const shared = ex.variables.filter(
      (v) => v.name !== ITEM_VARIABLE && v.name !== BATCH_MEMBERS_VARIABLE,
    )
    return (itemsOf(ex) as unknown[]).map((item, index) =>
      createExchange(item, {
        id: `${ex.id}.${index}`,
        meta: { ...ex.meta, parentId: ex.id, batchIndex: index },
        variables: shared,
      }),
    )
  }

  const overrides = batchOverrides(ex, pack.base)
  return pack.members.map((member, index) => {
    const next = overrides.length > 0 ? withVariable(member, ...overrides) : member
    return { ...next, meta: { ...next.meta, batchIndex: index } }
  })
}

/**
 * Merge variables of several exchanges (later wins on name+qualifier clash). Used by batch.
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
