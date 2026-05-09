import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

/**
 * Built-in Markdown Source — reads a .md file and yields a single envelope
 * containing the file contents as the item.
 */
export function createMdSource<T>(uri: ParsedUri): Source<T> {
  const filePath = uri.path || uri.host

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const content = await readFile(filePath, 'utf-8')
      yield { item: content as T, meta: {} }
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
      const content = await readFile(filePath, 'utf-8')
      yield { item: content as T, meta: {} }
    },
  }
}

/**
 * Built-in Markdown Target — writes envelope items to a .md file.
 * Each item is converted to a string and appended.
 */
export function createMdTarget<T>(uri: ParsedUri): Target<T> {
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
      const text = String(env.item)
      writeStream.write(text + '\n')
    },
    async close(_ctx: TargetContext): Promise<void> {
      if (writeStream) {
        const stream = writeStream
        writeStream = null
        await new Promise<void>((resolve, reject) => {
          stream.on('finish', resolve)
          stream.on('error', reject)
          stream.end()
        })
      }
    },
  }
}

// Register built-in Markdown source and target
registry.registerSource('md', createMdSource)
registry.registerTarget('md', createMdTarget)
