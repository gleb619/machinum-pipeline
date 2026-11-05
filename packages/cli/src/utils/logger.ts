import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createConsoleLogger, formatJsonLogLine, formatLogLine } from '@mt/core'
import type { LogFormat, Logger } from '@mt/core'

export type { LogFormat }

/**
 * Extract `--json`/`--jsonl` flags from a CLI arg list. Both spellings select the
 * JSONL log format. Returns the format and the remaining (positional) args, so flag
 * position does not matter and optional positional args survive.
 */
export function extractLogFormat(args: string[]): { format: LogFormat; args: string[] } {
  let format: LogFormat = 'text'
  const rest: string[] = []
  for (const arg of args) {
    if (arg === '--json' || arg === '--jsonl') {
      format = 'json'
    } else {
      rest.push(arg)
    }
  }
  return { format, args: rest }
}

/**
 * Duplex logger — writes to both console and a per-run .mt log file.
 *
 * The run id is not known when the logger is created, so lines are buffered until
 * `setRunId()` binds the logger to a run. The buffer is then flushed to
 * `<logDir>/<runId>/run.log` — the file `mt inspect <runId>` reads.
 *
 * `format` applies to both sinks: `text` is the shared markdown-safe human line,
 * `json` emits one JSON object per line (JSONL).
 */
export class DuplexLogger implements Logger {
  private readonly logDir: string
  private readonly format: LogFormat
  private readonly consoleLogger: Logger
  private runId: string | null = null
  private buffered: string[] = []
  private pendingWrites: Promise<void> = Promise.resolve()

  constructor(logDir: string, format: LogFormat = 'text') {
    this.logDir = logDir
    this.format = format
    this.consoleLogger = createConsoleLogger({ format })
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
    const line = `${this.formatLine(level, message, meta)}\n`
    if (!this.runId) {
      this.buffered.push(line)
      return
    }
    this.enqueue(line)
  }

  private formatLine(level: string, message: string, meta?: Record<string, unknown>): string {
    return this.format === 'json'
      ? formatJsonLogLine(level, message, meta)
      : formatLogLine(level, message, meta)
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
