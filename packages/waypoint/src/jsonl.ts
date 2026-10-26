// @ts-expect-error globSync is available in Node 22 but @types/node v20 doesn't include it
import { createReadStream, globSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Exchange, ExchangeInput, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import {
  AtomicStreamWriter,
  ITEM_VARIABLE,
  createExchange,
  mergeVariables,
  registry,
  toExchange,
  toPersisted,
} from '@mt/core'
import { resolveWaypointPath } from './settings.js'

/**
 * Cursor used when the source resolves a glob pattern.
 */
interface GlobCursor {
  fileIndex: number
  line: number
}

function isGlobCursor(cursor: unknown): cursor is GlobCursor {
  return (
    typeof cursor === 'object' &&
    cursor !== null &&
    'fileIndex' in cursor &&
    'line' in cursor &&
    typeof (cursor as GlobCursor).fileIndex === 'number' &&
    typeof (cursor as GlobCursor).line === 'number'
  )
}

function isGlobPattern(path: string): boolean {
  return path.includes('*') || path.includes('?') || path.includes('[')
}

/**
 * Parse one JSONL line into an Envelope. Malformed JSON or a missing `item`
 * throws with the `file:line` location of the offending physical line.
 */
function parseEnvelopeLine<T>(
  text: string,
  filePath: string,
  lineNumber: number,
  lineIndex: number,
): Exchange<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${filePath}:${lineNumber}: invalid JSON — ${(cause as Error).message}`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('item' in parsed || hasItemVariable((parsed as { variables?: unknown }).variables))
  ) {
    throw new Error(
      `${filePath}:${lineNumber}: invalid envelope — expected a JSON object with an "item" property or an "item" variable`,
    )
  }
  const { item, meta, id, variables } = parsed as {
    item?: T
    meta?: unknown
    id?: unknown
    variables?: unknown
  }
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    throw new Error(`${filePath}:${lineNumber}: invalid envelope — "meta" must be an object`)
  }
  if (variables !== undefined && !Array.isArray(variables)) {
    throw new Error(`${filePath}:${lineNumber}: invalid envelope — "variables" must be an array`)
  }
  return toExchange<T>({
    // Stable id: explicit `id` in the line, else file position (survives resume replays).
    id: typeof id === 'string' && id ? id : `${filePath}#${lineIndex}`,
    item: item as T,
    meta: (meta as Exchange<T>['meta']) ?? {},
    variables: (variables as Exchange<T>['variables']) ?? [],
  })
}

/** True when a persisted `variables` array carries the payload (`item` variable). */
function hasItemVariable(variables: unknown): boolean {
  return (
    Array.isArray(variables) &&
    variables.some((v) => typeof v === 'object' && v !== null && v.name === ITEM_VARIABLE)
  )
}

/** One envelope read from a JSONL file. */
interface FileLine<T> {
  envelope: Exchange<T>
  /** Envelope index among non-blank lines (0-based) — the value used in cursors. */
  lineIndex: number
}

/**
 * Read envelopes from a JSONL file starting at envelope index `startLine`.
 * Blank lines are skipped and never counted, so the numbering matches the
 * cursors emitted by glob mode and stays consistent between start and resume.
 */
async function* readLines<T>(filePath: string, startLine: number): AsyncGenerator<FileLine<T>> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY })

  // Physical line number (1-based) for error messages.
  let lineNumber = 0
  let lineIndex = 0
  for await (const line of rl) {
    lineNumber++
    const trimmed = line.trim()
    if (!trimmed) continue
    if (lineIndex < startLine) {
      lineIndex++
      continue
    }
    yield { envelope: parseEnvelopeLine<T>(trimmed, filePath, lineNumber, lineIndex), lineIndex }
    lineIndex++
  }
}

/**
 * Read envelopes across several files (glob mode), applying `startLine` only
 * to the first file.
 */
async function* readFiles<T>(files: string[], firstLine: number): AsyncGenerator<FileLine<T>> {
  let startLine = firstLine
  for (const file of files) {
    for await (const entry of readLines<T>(file, startLine)) {
      yield entry
    }
    startLine = 0 // Only apply offset to the first resumed file
  }
}

function* yieldBatch<T>(batch: Exchange<T>[], batchSize: number): Generator<Exchange<T>> {
  if (batch.length === 0) return
  if (batchSize === 1) {
    for (const env of batch) {
      yield env
    }
  } else {
    const first = batch[0]
    if (!first) return
    yield createExchange(first.item, {
      id: `batch:${first.id}`,
      items: batch.map((e) => e.item),
      meta: first.meta ?? {},
      variables: mergeVariables(batch),
    })
  }
}

/**
 * Group a line stream into batches of `batchSize` envelopes.
 */
async function* yieldBatched<T>(
  lines: AsyncIterable<FileLine<T>>,
  batchSize: number,
): AsyncGenerator<Exchange<T>> {
  let batch: Exchange<T>[] = []
  for await (const { envelope } of lines) {
    batch.push(envelope)
    if (batch.length >= batchSize) {
      yield* yieldBatch(batch, batchSize)
      batch = []
    }
  }
  yield* yieldBatch(batch, batchSize)
}

function resolveGlobFiles(filePath: string): string[] {
  const files = globSync(filePath).sort()
  if (files.length === 0) {
    throw new Error(`No files matched glob pattern: ${filePath}`)
  }
  return files
}

/**
 * Built-in JSONL Source — reads envelopes from a .jsonl file or glob pattern.
 * Each line is one JSON-encoded Envelope (`{ item, meta? }`); a missing `meta`
 * defaults to `{}`. Malformed lines throw with a `file:line` location.
 *
 * Cursor: for a single file, the envelope index among non-blank lines; for a
 * glob, `{ fileIndex, line }` (legacy numeric cursors map to the first file).
 *
 * Glob examples:
 *   jsonl://./jsonl/*.jsonl        — all JSONL files in ./jsonl/
 *   jsonl://./jsonl/** / *.jsonl   — recursive match (remove space in actual URI)
 *   jsonl://./data/chapter?.jsonl  — single-character wildcard
 */
export function createJsonlSource<T>(uri: ParsedUri): Source<T> {
  const batchSize = uri.query.batchSize ? Number.parseInt(uri.query.batchSize, 10) : 1

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const filePath = resolveWaypointPath(
        uri,
        'jsonl',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      if (isGlobPattern(filePath)) {
        yield* yieldBatched(readFiles<T>(resolveGlobFiles(filePath), 0), batchSize)
      } else {
        yield* yieldBatched(readLines<T>(filePath, 0), batchSize)
      }
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>> {
      const filePath = resolveWaypointPath(
        uri,
        'jsonl',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      if (isGlobPattern(filePath)) {
        let startFileIndex = 0
        let startLine = 0

        if (isGlobCursor(cursor)) {
          startFileIndex = cursor.fileIndex
          startLine = cursor.line
        } else if (typeof cursor === 'number') {
          // Legacy single-file cursor — treat as first file at given line
          startFileIndex = 0
          startLine = cursor
        } else {
          throw new Error(`invalid jsonl cursor: ${JSON.stringify(cursor)}`)
        }

        const files = resolveGlobFiles(filePath)
        yield* yieldBatched(readFiles<T>(files.slice(startFileIndex), startLine), batchSize)
      } else {
        if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
          throw new Error(`invalid jsonl cursor: ${JSON.stringify(cursor)}`)
        }
        yield* yieldBatched(readLines<T>(filePath, cursor), batchSize)
      }
    },
  }
}

/**
 * Built-in JSONL Target — writes envelopes to a .jsonl file.
 * Each envelope is serialised as one JSON line.
 *
 * Lines are streamed to a temp file and renamed onto the final path in
 * `close()`, so the .jsonl is never seen half-written and a rerun replaces
 * instead of appending duplicates.
 */
export function createJsonlTarget<T>(uri: ParsedUri): Target<T> {
  let writer: AtomicStreamWriter | null = null

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      const filePath = resolveWaypointPath(
        uri,
        'jsonl',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      writer = await AtomicStreamWriter.open(filePath, ctx.run.runId)
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      if (!writer) {
        throw new Error('Target not opened. Call open() before write().')
      }
      writer.write(`${JSON.stringify(toPersisted(env))}\n`)
    },
    async close(_ctx: TargetContext): Promise<void> {
      if (writer) {
        const pending = writer
        writer = null
        await pending.commit()
      }
    },
  }
}

// Register built-in JSONL source and target
registry.registerSource('jsonl', createJsonlSource)
registry.registerTarget('jsonl', createJsonlTarget)
