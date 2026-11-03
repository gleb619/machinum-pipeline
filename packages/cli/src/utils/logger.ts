import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createConsoleLogger, formatLogLine } from '@mt/core'
import type { Logger } from '@mt/core'

/**
 * Duplex logger — writes to both console and a per-run .mt log file.
 *
 * The run id is not known when the logger is created, so lines are buffered until
 * `setRunId()` binds the logger to a run. The buffer is then flushed to
 * `<logDir>/<runId>/run.log` — the file `mt inspect <runId>` reads.
 */
export class DuplexLogger implements Logger {
  private readonly logDir: string
  private readonly consoleLogger: Logger
  private runId: string | null = null
  private buffered: string[] = []
  private pendingWrites: Promise<void> = Promise.resolve()

  constructor(logDir: string) {
    this.logDir = logDir
    this.consoleLogger = createConsoleLogger()
  }

  /**
   * Bind the logger to a run. Lines logged before this call are buffered and
   * flushed to `<logDir>/<runId>/run.log`.
   */
  setRunId(runId: string): void {
    if (this.runId === runId) return
    this.runId = runId
    const buffered = this.buffered
    this.buffered = []
    for (const line of buffered) {
      this.enqueue(line)
    }
  }

  /** Resolve once every queued line has been written to disk. */
  async flush(): Promise<void> {
    await this.pendingWrites
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.info(message, meta)
    this.write('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.warn(message, meta)
    this.write('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.error(message, meta)
    this.write('error', message, meta)
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.debug(message, meta)
    this.write('debug', message, meta)
  }

  private write(level: string, message: string, meta?: Record<string, unknown>): void {
    const line = `${formatLogLine(level, message, meta)}\n`
    if (!this.runId) {
      this.buffered.push(line)
      return
    }
    this.enqueue(line)
  }

  private enqueue(line: string): void {
    const runId = this.runId
    if (!runId) return
    const runDir = join(this.logDir, runId)
    const logFile = join(runDir, 'run.log')
    this.pendingWrites = this.pendingWrites.then(async () => {
      try {
        await mkdir(runDir, { recursive: true })
        await appendFile(logFile, line, 'utf-8')
      } catch {
        // Silently fail on file logging errors
      }
    })
  }
}
