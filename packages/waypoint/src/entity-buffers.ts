import type { BufferWriter, ParsedUri, Source, Target } from '@mt/core'
import { registry } from '@mt/core'
import {
  appendNamedBuffer,
  createNamedEphemeralSource,
  createNamedEphemeralTarget,
  resetNamedBuffer,
} from './ephemeral.js'
import { annotateWaypoint } from './registration.js'

/**
 * Entity-level shortcuts for the in-memory buffer.
 *
 * These are the same process-local buffers as `ephemeral://`, but named after
 * the entity the pipeline is handing off:
 *
 *   batches://<namespace>     Fixed-size packages (batch subflow packages, `items[]` + members)
 *   chapters://<namespace>    Chapter envelopes
 *   paragraphs://<namespace>  Paragraph envelopes
 *   chunks://<namespace>      Chunk envelopes
 *   tokens://<namespace>      Token envelopes (alternate descent from chunks)
 *   lines://<namespace>       Line envelopes
 *   words://<namespace>       Word envelopes
 *
 * Ladder rungs (`chapters://` ... `words://`, `tokens://`) are **creational**, not
 * terminal: a split-form subflow fills them through the matching explicit target —
 * `.subflow('chunks://', pipe)` with `.to('chunks://ladder')` inside `pipe` — and the
 * next stage reads the buffer back with `.from('chunks://ladder')`. Every entity scheme
 * is bidirectional (source + target); `batches://` additionally carries batch-subflow
 * packages (`.subflow('batch://?size=N', pipe)`) because it is not a ladder rung.
 *
 * Not to be confused with `batch://group|members|return` (`batch-scope.ts`): those are the
 * child-side views of `.subflow('batch://?size=N', pipe)` and share no global buffer.
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

/** Every entity buffer key space understood by the entity-buffer waypoints. */
export const ENTITY_BUFFER_SCHEMES = [...PACKAGE_BUFFER_SCHEMES, ...LADDER_BUFFER_SCHEMES] as const

export type LadderBufferScheme = (typeof LADDER_BUFFER_SCHEMES)[number]
export type PackageBufferScheme = (typeof PACKAGE_BUFFER_SCHEMES)[number]
export type EntityBufferScheme = (typeof ENTITY_BUFFER_SCHEMES)[number]

/** Resolve the concrete buffer key for a scheme + namespace. */
export function entityBufferKeyForNamespace(scheme: EntityBufferScheme, namespace: string): string {
  return `${scheme}:${namespace || 'default'}`
}

/** Resolve the concrete buffer key for a scheme + URI. */
export function entityBufferKey(scheme: EntityBufferScheme, uri: ParsedUri): string {
  return entityBufferKeyForNamespace(scheme, uri.path || uri.host)
}

/** Source for an entity namespace (reads what an earlier stage's target wrote). */
export function createEntityBufferSource<T>(scheme: EntityBufferScheme, uri: ParsedUri): Source<T> {
  return createNamedEphemeralSource<T>(uri, entityBufferKey(scheme, uri))
}

/**
 * Target for an entity namespace (clears the buffer on open, then appends).
 * This is how a split-form subflow publishes its children: `.subflow('chunks://', pipe)`
 * with `.to('chunks://ladder')` inside `pipe`. The target opens once per stage (one
 * nested child run per split step), so the reset-at-stage-start contract holds.
 * Deliberately no `checkpoint()`: the buffer is process-local, so a resume replays.
 */
export function createEntityBufferTarget<T>(scheme: EntityBufferScheme, uri: ParsedUri): Target<T> {
  return createNamedEphemeralTarget<T>(uri, entityBufferKey(scheme, uri))
}

/**
 * Write side shared with the explicit buffer targets above. It uses the same key space,
 * so `chunks` + `ladder` fills the buffer that `chunks://ladder` reads. Kept on the
 * registry for tests and custom pipelines; pipeline code writes via `.to('<scheme>://ns')`.
 */
export function createEntityBufferWriter(
  scheme: EntityBufferScheme,
  namespace: string,
): BufferWriter {
  const key = entityBufferKeyForNamespace(scheme, namespace)
  return {
    reset(): void {
      resetNamedBuffer(key)
    },
    append(env): void {
      appendNamedBuffer(key, env)
    },
  }
}

// The entity buffers bind the scheme into their factory, so each scheme gets its
// own registration — they are annotated but not registered through the shared pair
// helper.
annotateWaypoint(createEntityBufferSource, {
  id: 'WT015',
  name: 'entity buffer source',
  description: 'Reads/writes typed in-memory entity buffers (batches and Structure Ladder rungs).',
  schemes: [...ENTITY_BUFFER_SCHEMES],
  direction: 'source',
})
annotateWaypoint(createEntityBufferTarget, {
  id: 'WT015',
  name: 'entity buffer target',
  description: 'Reads/writes typed in-memory entity buffers (batches and Structure Ladder rungs).',
  schemes: [...ENTITY_BUFFER_SCHEMES],
  direction: 'target',
})

for (const scheme of ENTITY_BUFFER_SCHEMES) {
  registry.registerSource(scheme, (uri: ParsedUri) => createEntityBufferSource(scheme, uri))
  registry.registerTarget(scheme, (uri: ParsedUri) => createEntityBufferTarget(scheme, uri))
}

// Buffer writers back the explicit buffer targets and stay available to tests and
// custom pipelines that fill a buffer directly.
for (const scheme of ENTITY_BUFFER_SCHEMES) {
  registry.registerBufferWriter(scheme, (namespace) => createEntityBufferWriter(scheme, namespace))
}
