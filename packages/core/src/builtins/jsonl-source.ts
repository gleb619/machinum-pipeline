import { createReadStream, createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SourceContext, TargetContext } from '../contexts.js'
import type { Envelope, Source, Target } from '../types.js'
import type { ParsedUri } from '../uri.js'
import { registry } from '../uri.js'

/**
 * Built-in JSONL Source — reads envelopes from a .jsonl file.
 * Each line is one JSON-encoded Envelope.
 */
export function createJsonlSource<T>(uri: ParsedUri): Source<T> {
  const filePath = uri.path || uri.host
  const batchSize = uri.query.batchSize ? Number.parseInt(uri.query.batchSize, 10) : 1

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
      const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY })

      let batch: Envelope<T>[] = []

      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const envelope = JSON.parse(trimmed) as Envelope<T>
        batch.push(envelope)

        if (batch.length >= batchSize) {
          if (batchSize === 1) {
            yield batch[0] as Envelope<T>
          } else {
            yield {
              item: (batch[0] as Envelope<T>).item,
              items: batch.map((e) => e.item),
              meta: batch[0]?.meta ?? {},
            }
          }
          batch = []
        }
      }

      // Yield remaining items
      for (const env of batch) {
        yield env
      }
    },
    async *resume(_ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
      const cursorLine = cursor as number
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n').slice(cursorLine)

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        yield JSON.parse(trimmed) as Envelope<T>
      }
    },
  }
}

/**
 * Built-in JSONL Target — writes envelopes to a .jsonl file.
 * Each envelope is serialised as one JSON line.
 */
export function createJsonlTarget<T>(uri: ParsedUri): Target<T> {
  const filePath = uri.path || uri.host
  let writeStream: ReturnType<typeof createWriteStream> | null = null

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
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
