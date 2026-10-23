import { randomBytes } from 'node:crypto'
import { type WriteStream, createWriteStream } from 'node:fs'
import { readdir, rename, unlink, writeFile } from 'node:fs/promises'
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
 * Streaming counterpart of {@link atomicWriteFile} for targets that receive
 * envelopes one at a time and only know the full content at `close()`.
 *
 * Writes land in a temp file; `commit()` renames it onto the final path, so the
 * target file stays either untouched or complete — never partially written.
 * An abandoned writer (crash) leaves the final path alone and its temp file is
 * swept by the next `open()`.
 */
export class AtomicStreamWriter {
  /** Final path the content is published to on commit. */
  readonly filePath: string
  /** Sibling temp path currently receiving writes. */
  readonly tmpPath: string
  private readonly stream: WriteStream
  private failure: Error | null = null
  private settled = false

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
   * Start a fresh atomic write to `filePath`, sweeping temp files left by any
   * earlier interrupted run. Resolves once the temp file is actually open, so a
   * missing directory or bad path fails here rather than mid-stream.
   */
  static async open(filePath: string, tag?: string): Promise<AtomicStreamWriter> {
    await removeStaleTmpFiles(filePath)
    const tmpPath = tmpPathFor(filePath, tag)
    const stream = createWriteStream(tmpPath, { encoding: 'utf-8', flags: 'w' })
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

  /** Append a chunk to the temp file. Throws if an earlier write failed. */
  write(chunk: string): void {
    if (this.failure) throw this.failure
    if (this.settled) throw new Error('Atomic writer is already closed.')
    this.stream.write(chunk)
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
