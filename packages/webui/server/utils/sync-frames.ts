import type { IncomingMessage } from 'node:http'
import { MAX_REQUEST_BYTES } from '@mt/core'

const MAX_HEADER_BYTES = 64 * 1024

export interface SyncFrameHeader {
  path: string
  op?: 'write' | 'delete'
  size?: number
  sha256?: string
}

export interface SyncFrame {
  header: SyncFrameHeader
  body?: Buffer
}

class FrameReader {
  private readonly iterator: AsyncIterator<Buffer | string>
  private readonly chunks: Buffer[] = []
  private available = 0
  private done = false

  constructor(request: IncomingMessage) {
    this.iterator = (request as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]()
  }

  private async nextChunk(): Promise<Buffer | undefined> {
    while (!this.done) {
      const next = await this.iterator.next()
      if (next.done) {
        this.done = true
        return undefined
      }
      const value = next.value
      return Buffer.isBuffer(value) ? value : Buffer.from(value)
    }
    return undefined
  }

  private async fill(size: number): Promise<void> {
    while (this.available < size) {
      const chunk = await this.nextChunk()
      if (chunk === undefined) throw new Error('Truncated sync frame')
      if (chunk.length === 0) continue
      this.chunks.push(chunk)
      this.available += chunk.length
    }
  }

  async readExact(size: number): Promise<Buffer> {
    await this.fill(size)
    const output = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const chunk = this.chunks[0]
      if (chunk === undefined) throw new Error('Truncated sync frame')
      const take = Math.min(chunk.length, size - offset)
      chunk.copy(output, offset, 0, take)
      offset += take
      this.available -= take
      if (take === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
    }
    return output
  }

  async readFrame(): Promise<SyncFrame | undefined> {
    if (this.available === 0) {
      const chunk = await this.nextChunk()
      if (chunk === undefined) return undefined
      if (chunk.length > 0) {
        this.chunks.push(chunk)
        this.available += chunk.length
      }
    }
    await this.fill(4)
    const lengthBytes = await this.readExact(4)
    const headerLength = lengthBytes.readUInt32BE(0)
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error(`Invalid sync frame header length: ${headerLength}`)
    }
    const rawHeader = (await this.readExact(headerLength)).toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(rawHeader)
    } catch {
      throw new Error('Invalid sync frame header JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid sync frame header')
    }
    const record = parsed as Record<string, unknown>
    const path = record.path
    const op = record.op
    const size = record.size
    const sha256 = record.sha256
    if (typeof path !== 'string' || path === '') throw new Error('Sync frame path is required')
    if (op !== undefined && op !== 'write' && op !== 'delete') {
      throw new Error('Sync frame op must be "write" or "delete"')
    }
    if (
      size !== undefined &&
      (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    ) {
      throw new Error('Sync frame size must be a non-negative integer')
    }
    if (sha256 !== undefined && typeof sha256 !== 'string') {
      throw new Error('Sync frame sha256 must be a string')
    }
    const operation = op ?? 'write'
    const bodySize = operation === 'delete' ? 0 : (size ?? 0)
    if (bodySize > MAX_REQUEST_BYTES) {
      throw new Error('Sync frame body exceeds the 64 MB request cap')
    }
    const body = bodySize > 0 ? await this.readExact(bodySize) : undefined
    return { header: { path, op: operation, size: bodySize, sha256 }, body }
  }
}

/** Read all length-prefixed JSON-header + body frames until the request stream ends. */
export async function* readSyncFrames(request: IncomingMessage): AsyncGenerator<SyncFrame> {
  const reader = new FrameReader(request)
  for (;;) {
    const frame = await reader.readFrame()
    if (frame === undefined) return
    yield frame
  }
}
