import type { ParsedUri, Source, Target } from '@mt/core'
import { registry } from '@mt/core'
import { createNamedEphemeralSource, createNamedEphemeralTarget } from './ephemeral.js'

/**
 * Entity-level shortcuts for the in-memory buffer.
 *
 * These are the same process-local buffers as `ephemeral://`, but named after
 * the entity the pipeline is handing off:
 *
 *   chapters://<namespace>    Chapter envelopes
 *   paragraphs://<namespace>  Paragraph envelopes
 *   chunks://<namespace>      Chunk envelopes
 *   tokens://<namespace>      Token envelopes (alternate descent from chunks)
 *   lines://<namespace>       Line envelopes
 *   words://<namespace>       Word envelopes
 *
 * Omitting the namespace uses `default`: `paragraphs://` == `paragraphs://default`.
 * Every scheme gets its own key space, so `lines://` never reads a buffer that
 * `ephemeral://lines` or `paragraphs://` wrote.
 */

export const ENTITY_BUFFER_SCHEMES = [
  'chapters',
  'paragraphs',
  'chunks',
  'tokens',
  'lines',
  'words',
] as const

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

for (const scheme of ENTITY_BUFFER_SCHEMES) {
  registry.registerSource(scheme, (uri: ParsedUri) => createEntityBufferSource(scheme, uri))
  registry.registerTarget(scheme, (uri: ParsedUri) => createEntityBufferTarget(scheme, uri))
}
