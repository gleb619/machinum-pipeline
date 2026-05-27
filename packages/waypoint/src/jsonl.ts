// @ts-expect-error globSync is available in Node 22 but @types/node v20 doesn't include it
import { createReadStream, createWriteStream, globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'
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

async function* readFileEnvelopes<T>(
  filePath: string,
  startLine: number,
): AsyncGenerator<{ envelope: Envelope<T>; lineIndex: number }> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY })

  let lineIndex = 0
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (lineIndex < startLine) {
      lineIndex++
      continue
    }
    yield { envelope: JSON.parse(trimmed) as Envelope<T>, lineIndex }
    lineIndex++
  }
}

function* yieldBatch<T>(batch: Envelope<T>[], batchSize: number): Generator<Envelope<T>> {
  if (batch.length === 0) return
  if (batchSize === 1) {
    for (const env of batch) {
      yield env
    }
  } else {
    const first = batch[0]
    if (!first) return
    yield {
      item: first.item,
      items: batch.map((e) => e.item),
      meta: first.meta ?? {},
    }
  }
}

/**
 * Built-in JSONL Source — reads envelopes from a .jsonl file or glob pattern.
 * Each line is one JSON-encoded Envelope.
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
    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const filePath = resolveWaypointPath(uri, 'jsonl', ctx.run.global.settings)
      const globMode = isGlobPattern(filePath)
      if (globMode) {
        const files = globSync(filePath).sort()
        if (files.length === 0) {
          throw new Error(`No files matched glob pattern: ${filePath}`)
        }

        let batch: Envelope<T>[] = []
        for (const matchedFile of files) {
          for await (const { envelope } of readFileEnvelopes<T>(matchedFile, 0)) {
            batch.push(envelope)
            if (batch.length >= batchSize) {
              yield* yieldBatch(batch, batchSize)
              batch = []
            }
          }
        }
        yield* yieldBatch(batch, batchSize)
      } else {
        const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
        const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY })

        let batch: Envelope<T>[] = []

        for await (const line of rl) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const envelope = JSON.parse(trimmed) as Envelope<T>
          batch.push(envelope)

          if (batch.length >= batchSize) {
            yield* yieldBatch(batch, batchSize)
            batch = []
          }
        }

        yield* yieldBatch(batch, batchSize)
      }
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
      const filePath = resolveWaypointPath(uri, 'jsonl', ctx.run.global.settings)
      const globMode = isGlobPattern(filePath)
      if (globMode) {
        const files = globSync(filePath).sort()
        if (files.length === 0) {
          throw new Error(`No files matched glob pattern: ${filePath}`)
        }

        let startFileIndex = 0
        let startLine = 0

        if (isGlobCursor(cursor)) {
          startFileIndex = cursor.fileIndex
          startLine = cursor.line
        } else if (typeof cursor === 'number') {
          // Legacy single-file cursor — treat as first file at given line
          startFileIndex = 0
          startLine = cursor
        }

        let batch: Envelope<T>[] = []
        for (let fileIndex = startFileIndex; fileIndex < files.length; fileIndex++) {
          for await (const { envelope } of readFileEnvelopes<T>(files[fileIndex], startLine)) {
            startLine = 0 // Only apply offset to the first resumed file
            batch.push(envelope)
            if (batch.length >= batchSize) {
              yield* yieldBatch(batch, batchSize)
              batch = []
            }
          }
        }
        yield* yieldBatch(batch, batchSize)
      } else {
        const cursorLine = cursor as number
        const content = await readFile(filePath, 'utf-8')
        const lines = content.split('\n').slice(cursorLine)

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          yield JSON.parse(trimmed) as Envelope<T>
        }
      }
    },
  }
}

/**
 * Built-in JSONL Target — writes envelopes to a .jsonl file.
 * Each envelope is serialised as one JSON line.
 */
export function createJsonlTarget<T>(uri: ParsedUri): Target<T> {
  let writeStream: ReturnType<typeof createWriteStream> | null = null

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      const filePath = resolveWaypointPath(uri, 'jsonl', ctx.run.global.settings)
      writeStream = createWriteStream(filePath, { encoding: 'utf-8', flags: 'a' })
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      if (!writeStream) {
        throw new Error('Target not opened. Call open() before write().')
      }
      writeStream.write(`${JSON.stringify(env)}\n`)
    },
    async close(_ctx: TargetContext): Promise<void> {
      if (writeStream) {
        writeStream.end()
        writeStream = null
      }
    },
  }
}

// Register built-in JSONL source and target
registry.registerSource('jsonl', createJsonlSource)
registry.registerTarget('jsonl', createJsonlTarget)
