import type { ParsedUri, Source, Target } from '@mt/core'
import { registry } from '@mt/core'
import { createNamedEphemeralSource, createNamedEphemeralTarget } from './ephemeral.js'

/**
 * Entity-level shortcuts for the in-memory buffer.
 *
 * These are the same process-local buffers as `ephemeral://`, but named after
 * the entity the pipeline is handing off:
 *
 *   batches://<namespace>     Fixed-size packages (`.batch(n)` groups, `items[]` + members)
 *   chapters://<namespace>    Chapter envelopes
 *   paragraphs://<namespace>  Paragraph envelopes
 *   chunks://<namespace>      Chunk envelopes
 *   tokens://<namespace>      Token envelopes (alternate descent from chunks)
 *   lines://<namespace>       Line envelopes
 *   words://<namespace>       Word envelopes
 *
 * Ladder rungs (`chapters://` ... `words://`, `tokens://`) are **creational**, not
 * terminal: they are registered as sources only. A stage hands its output to the
 * write side, `temp://<entity>/<namespace>`, and the next stage reads it back
 * through the typed rung (`chunks://ladder` <- `temp://chunks/ladder`).
 * `batches://` stays a bidirectional package buffer because it is not a ladder rung.
 *
 * Omitting the namespace uses `default`: `paragraphs://` == `paragraphs://default`.
 * Every scheme gets its own key space, so `lines://` never reads a buffer that
 * `ephemeral://lines` or `paragraphs://` wrote.
 */

/** Typed ladder rungs: source-only views over entities created by an earlier stage. */
export const LADDER_BUFFER_SCHEMES = [
  'chapters',
  'paragraphs',
  'chunks',
  'tokens',
  'lines',
  'words',
] as const

/** Package buffers: `batches://` is both a source and a target (not a ladder rung). */
export const PACKAGE_BUFFER_SCHEMES = ['batches'] as const

/** Every buffer key space understood by `temp://<entity>/<namespace>`. */
export const ENTITY_BUFFER_SCHEMES = [...PACKAGE_BUFFER_SCHEMES, ...LADDER_BUFFER_SCHEMES] as const

export type LadderBufferScheme = (typeof LADDER_BUFFER_SCHEMES)[number]
export type PackageBufferScheme = (typeof PACKAGE_BUFFER_SCHEMES)[number]
export type EntityBufferScheme = (typeof ENTITY_BUFFER_SCHEMES)[number]

/** Resolve the concrete buffer key for a scheme + URI. */
export function entityBufferKey(scheme: EntityBufferScheme, uri: ParsedUri): string {
  return `${scheme}:${uri.path || uri.host || 'default'}`
}

/** Source for an entity namespace (reads what the matching target wrote). */
export function createEntityBufferSource<T>(scheme: EntityBufferScheme, uri: ParsedUri): Source<T> {
  return createNamedEphemeralSource<T>(uri, entityBufferKey(scheme, uri))
}

/** Target for an entity namespace (clears the buffer on open, then appends). */
export function createEntityBufferTarget<T>(scheme: EntityBufferScheme, uri: ParsedUri): Target<T> {
  return createNamedEphemeralTarget<T>(uri, entityBufferKey(scheme, uri))
}

/**
 * Write side of an entity buffer: `temp://<entity>/<namespace>`.
 *
 * Target-only. It stores envelopes under the same key the matching typed source
 * (`<entity>://<namespace>`) reads, so a ladder rung never needs a writable scheme
 * of its own.
 */
export function createTempBufferTarget<T>(uri: ParsedUri): Target<T> {
  const scheme = uri.host
  const namespace = uri.path.replace(/^\/+/, '')
  if (!scheme) {
    throw new Error(
      `temp:// needs an entity scheme: temp://<entity>/<namespace> (Known: ${ENTITY_BUFFER_SCHEMES.join(', ')})`,
    )
  }
  if (!(ENTITY_BUFFER_SCHEMES as readonly string[]).includes(scheme)) {
    throw new Error(
      `Unknown entity buffer scheme '${scheme}' in ${uri.raw} (Known: ${ENTITY_BUFFER_SCHEMES.join(', ')})`,
    )
  }
  if (namespace.includes('/')) {
    throw new Error(`temp:// namespace must be a single segment in ${uri.raw} (got '${namespace}')`)
  }
  return createNamedEphemeralTarget<T>(uri, `${scheme}:${namespace || 'default'}`)
}

for (const scheme of ENTITY_BUFFER_SCHEMES) {
  registry.registerSource(scheme, (uri: ParsedUri) => createEntityBufferSource(scheme, uri))
}

// Ladder rungs are creational: source-only. Only package buffers stay writable.
for (const scheme of PACKAGE_BUFFER_SCHEMES) {
  registry.registerTarget(scheme, (uri: ParsedUri) => createEntityBufferTarget(scheme, uri))
}

// The single write side for every entity buffer, including source-only ladder rungs.
registry.registerTarget('temp', createTempBufferTarget)
