import { writeFile } from 'node:fs/promises'
import { AtomicStreamWriter, pathExists, tmpPathFor, truncateFileToBytes } from '@mt/core'

/** Options for {@link ResumableStagedWriter.open}. */
export interface StagedWriterOptions {
  /**
   * Durable cursor the resumed run continues from. `undefined` starts a fresh
   * run: stale temp files are swept and the staging file starts empty.
   */
  resumeCursor?: number
  /**
   * Prepare the staging file for a resumed run and return the byte offset the
   * session appends at. The staging file must exist afterwards.
   */
  restore: (stagingPath: string, resumeCursor: number) => Promise<number>
  /** Runs before a fresh writer is opened (e.g. sweeping stale sidecars). */
  onFresh?: () => Promise<void>
}

/**
 * Staged writer shared by the single-file waypoint targets (`md://<file>`,
 * `jsonl://<file>`).
 *
 * The output is streamed into `<filePath>.tmp.<runId>` and published onto the
 * final path on `close()`, so the target file is never seen half-written. A
 * resumed run continues in the *same* staging file: the caller restores the
 * durable boundary (the byte offset of the last persisted envelope) and the
 * writer appends from there.
 */
export class ResumableStagedWriter {
  private writer: AtomicStreamWriter | null = null
  /** Byte offset in the staging file where this session starts appending. */
  private baseBytes = 0

  constructor(
    /** Final path the staged content is published to. */
    readonly filePath: string,
    /** Run id — the staging file is `<filePath>.tmp.<runId>`. */
    readonly runId: string,
  ) {}

  /** Path of the run-scoped staging file. */
  get stagingPath(): string {
    return tmpPathFor(this.filePath, this.runId)
  }

  /** Byte offset in the staging file where this session starts appending. */
  get baseOffset(): number {
    return this.baseBytes
  }

  /** Bytes staged by this session (the restored base is not counted). */
  get bytesWritten(): number {
    return this.writer?.bytesWritten ?? 0
  }

  /**
   * Open the staging file. Without a `resumeCursor` the run starts fresh and
   * stale temp files are swept; otherwise the staging file is restored and
   * truncated to the durable boundary before the writer appends to it.
   */
  async open(options: StagedWriterOptions): Promise<void> {
    if (options.resumeCursor === undefined) {
      await options.onFresh?.()
      this.writer = await AtomicStreamWriter.open(this.filePath, this.runId)
      return
    }
    const boundary = await options.restore(this.stagingPath, options.resumeCursor)
    this.baseBytes = boundary
    if (await pathExists(this.stagingPath)) {
      await truncateFileToBytes(this.stagingPath, boundary)
    } else {
      await writeFile(this.stagingPath, '')
    }
    this.writer = await AtomicStreamWriter.open(this.filePath, {
      tag: this.runId,
      append: true,
    })
  }

  /** Stage one chunk in the staging file. */
  async write(chunk: string): Promise<void> {
    const writer = this.writer
    if (!writer) {
      throw new Error('Target not opened. Call open() before write().')
    }
    await writer.write(chunk)
  }

  /** Flush staged bytes to disk without publishing them. */
  async sync(): Promise<void> {
    await this.writer?.sync()
  }

  /** Publish the staged content onto the final path. */
  async close(): Promise<void> {
    const pending = this.writer
    this.writer = null
    if (pending) await pending.commit()
  }
}
