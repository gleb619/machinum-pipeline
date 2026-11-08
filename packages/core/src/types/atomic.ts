/** Options for {@link atomicWriteFile}. */
export interface AtomicWriteOptions {
  /** File mode of the written file (e.g. `0o600` for secret files). */
  mode?: number
  /** Create the parent directory when it is missing. */
  createParent?: boolean
  /** Mode of the created parent directory (default: Node's default for `mkdir`). */
  parentMode?: number
  /**
   * Inspect the temp file before it is published. Throwing aborts the write and
   * leaves the target untouched.
   */
  verify?: (tmpPath: string) => Promise<void>
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
