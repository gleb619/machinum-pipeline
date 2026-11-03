import { createReadStream } from 'node:fs'

export interface NewLines {
  /** Complete (newline-terminated) lines decoded from the file, in order. */
  lines: string[]
  /** Byte offset just past the last newline — where the next read must resume. */
  nextOffset: number
}

/**
 * Read `path` from `offset` (a byte offset, as accepted by `createReadStream({ start })`)
 * and return only complete lines: decoding stops at the last `\n`, so a line split
 * across stream chunks or still being appended is held back for the next call.
 */
export function readNewLines(path: string, offset: number): Promise<NewLines> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: offset })
    const chunks: Buffer[] = []

    stream.on('data', (chunk: Buffer | string) => {
      // no `encoding` is set, so chunks are raw Buffers; stay byte-accurate either way
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8'))
    })

    stream.on('end', () => {
      const buf = Buffer.concat(chunks)
      const lastNewline = buf.lastIndexOf('\n')
      if (lastNewline === -1) {
        resolve({ lines: [], nextOffset: offset })
        return
      }
      const complete = buf.subarray(0, lastNewline + 1).toString('utf-8')
      resolve({
        lines: complete.split('\n').filter((l) => l.trim()),
        nextOffset: offset + lastNewline + 1,
      })
    })

    stream.on('error', reject)
  })
}
