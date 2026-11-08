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
  /** Batch payload list (the `item` is the same array); read via {@link itemsOf}. */
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

/**
 * Persisted form of an Exchange: no `meta`, no ephemeral variables, and NO separate `item` field -
 * the payload lives only in the `item` variable.
 */
export interface PersistedExchange {
  id: string
  items?: unknown[]
  variables: Variable[]
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

export interface VariableOptions {
  qualifier?: Qualifier
  ephemeral?: boolean
  id?: string
  timestamp?: string
}

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
