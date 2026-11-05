import { randomBytes } from 'node:crypto'
import { type WriteStream, createWriteStream, fsync } from 'node:fs'
import { access, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Atomic file I/O — the hard rule from CLAUDE.md: "File writes are atomic
 * (temp-then-rename)". Data lands in a sibling temp file first and only becomes
 * visible at its final path once it is complete, so a crash can never leave a
 * truncated or half-appended file behind.
 */

/** Marker prefix for temp siblings of a final path. */
const TMP_MARKER = '.tmp.'

/**
 * Build a temp path for `filePath`. The temp file is always a sibling so the
 * later `rename()` stays on the same filesystem (rename across devices fails).
 */
export function tmpPathFor(
  filePath: string,
  tag = `${Date.now()}-${randomBytes(4).toString('hex')}`,
): string {
  return `${filePath}${TMP_MARKER}${tag}`
}

/** Delete the temp file, ignoring a missing or already-removed path. */
async function discardTmp(tmpPath: string): Promise<void> {
  await unlink(tmpPath).catch(() => {})
}

/**
 * Write `data` to `filePath` atomically: temp file → rename.
 * The parent directory must already exist.
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = tmpPathFor(filePath)
  try {
    await writeFile(tmpPath, data, 'utf-8')
    await rename(tmpPath, filePath)
  } catch (error) {
    await discardTmp(tmpPath)
    throw error
  }
}

/**
 * Remove temp siblings left behind by an interrupted run. Called before a
 * target starts writing so a crashed run's partial output is never reused.
 */
export async function removeStaleTmpFiles(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}${TMP_MARKER}`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // Directory does not exist yet — nothing to clean
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => discardTmp(join(dir, entry))),
  )
}

/**
 * Cut `filePath` down to its first `bytes` bytes. Used by incremental targets to
 * drop staged envelopes written past the last durable checkpoint on resume.
 */
export async function truncateFileToBytes(filePath: string, bytes: number): Promise<void> {
  const handle = await open(filePath, 'r+')
  try {
    await handle.truncate(bytes)
  } finally {
    await handle.close()
  }
}

/** Options for {@link AtomicStreamWriter.open}. */
export interface AtomicStreamWriterOptions {
  /** Temp-file suffix; pass the run id so a resume can find its own staging file. */
  tag?: string
  /**
   * Append to an existing run-scoped temp file instead of starting fresh. No stale-temp
   * sweep runs in this mode — the caller owns alignment and must truncate first.
   */
  append?: boolean
}

/**
 * Streaming counterpart of {@link atomicWriteFile} for targets that receive
 * envelopes one at a time and only know the full content at `close()`.
 *
 * Writes land in a temp file; `commit()` renames it onto the final path, so the
 * target file stays either untouched or complete — never partially written.
 * An abandoned writer (crash) leaves the final path alone and its temp file is
 * swept by the next fresh `open()`.
 */
export class AtomicStreamWriter {
  /** Final path the content is published to on commit. */
  readonly filePath: string
  /** Sibling temp path currently receiving writes. */
  readonly tmpPath: string
  private readonly stream: WriteStream
  private failure: Error | null = null
  private settled = false
  private committedChunks = 0
  private writtenBytes = 0

  private constructor(filePath: string, tmpPath: string, stream: WriteStream) {
    this.filePath = filePath
    this.tmpPath = tmpPath
    this.stream = stream
    // Keep stream errors from going unhandled; surface them on the next
    // write()/commit() instead of losing them behind an event listener.
    this.stream.on('error', (error: Error) => {
      this.failure = error
    })
  }

  /**
   * Open a writer for `filePath`. A fresh writer sweeps temp files left by any
   * earlier interrupted run; an appending writer reuses this run's staging file
   * so a resumed target can continue where the durable cursor left off.
   * Resolves once the temp file is actually open, so a missing directory or bad
   * path fails here rather than mid-stream.
   */
  static async open(
    filePath: string,
    options?: string | AtomicStreamWriterOptions,
  ): Promise<AtomicStreamWriter> {
    // Keep the historical `open(filePath, tag)` string form working.
    const resolved = typeof options === 'string' ? { tag: options } : (options ?? {})
    if (!resolved.append) await removeStaleTmpFiles(filePath)
    const tmpPath = tmpPathFor(filePath, resolved.tag)
    let flags: 'w' | 'a' = 'w'
    if (resolved.append) {
      try {
        await access(tmpPath)
        flags = 'a'
      } catch {
        flags = 'w'
      }
    }
    const stream = createWriteStream(tmpPath, { encoding: 'utf-8', flags })
    const writer = new AtomicStreamWriter(filePath, tmpPath, stream)
    try {
      await writer.whenOpen()
    } catch (error) {
      await writer.abort()
      throw error
    }
    return writer
  }

  /** Resolves once the underlying stream has its temp file open. */
  private whenOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stream.once('open', () => resolve())
      this.stream.once('error', reject)
    })
  }

  /** Flush the temp file's file descriptor to disk when the stream exposes one. */
  private async fsyncStream(): Promise<void> {
    // `fd` is typed on fs.WriteStream but not on the WriteStream interface in older
    // @types/node; mocked streams in tests do not expose one either.
    const fd = (this.stream as unknown as { fd?: number }).fd
    if (typeof fd !== 'number') return
    await new Promise<void>((resolve, reject) => {
      fsync(fd, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Append a chunk to the temp file. Resolves once the chunk has been flushed to
   * the underlying file descriptor (the WriteStream callback), so a resolved
   * write is safe to count as staged. Throws if an earlier write failed.
   */
  async write(chunk: string): Promise<void> {
    if (this.failure) throw this.failure
    if (this.settled) throw new Error('Atomic writer is already closed.')
    await new Promise<void>((resolve, reject) => {
      this.stream.write(chunk, (error?: Error | null) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.committedChunks += 1
    this.writtenBytes += Buffer.byteLength(chunk, 'utf-8')
    if (this.failure) throw this.failure
  }

  /**
   * Flush staged writes to disk without publishing. Incremental targets call this
   * from `Target.checkpoint()` so the runner's persisted cursor never advances past
   * output that a crash could lose.
   */
  async sync(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.settled) return
    await this.fsyncStream()
  }

  /** Number of chunks flushed through {@link write}. */
  get chunksWritten(): number {
    return this.committedChunks
  }

  /** Number of bytes flushed through {@link write}. */
  get bytesWritten(): number {
    return this.writtenBytes
  }

  /** Flush, then rename the temp file onto the final path. Idempotent. */
  async commit(): Promise<void> {
    if (this.settled) return
    this.settled = true
    if (this.failure) {
      await this.abort()
      throw this.failure
    }
    try {
      await this.fsyncStream()
      await new Promise<void>((resolve, reject) => {
        this.stream.on('error', reject)
        this.stream.on('finish', resolve)
        this.stream.end()
      })
      await rename(this.tmpPath, this.filePath)
    } catch (error) {
      await this.abort()
      throw error
    }
  }

  /** Drop the temp file; the final path is left untouched. */
  async abort(): Promise<void> {
    this.stream.destroy()
    await discardTmp(this.tmpPath)
  }
}
