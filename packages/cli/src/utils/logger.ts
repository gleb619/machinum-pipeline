import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@mt/core'

/**
 * Duplex logger — writes to both console and a .mt log file.
 */
export class DuplexLogger implements Logger {
  private readonly logDir: string
  private readonly consoleLogger: Logger

  constructor(logDir: string) {
    this.logDir = logDir
    this.consoleLogger = createConsoleLogger()
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.info(message, meta)
    void this.writeToFile('INFO', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.warn(message, meta)
    void this.writeToFile('WARN', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.error(message, meta)
    void this.writeToFile('ERROR', message, meta)
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.consoleLogger.debug(message, meta)
    void this.writeToFile('DEBUG', message, meta)
  }

  private async writeToFile(level: string, message: string, meta?: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true })
      const logFile = join(this.logDir, 'run.log')
      const timestamp = new Date().toISOString()
      const line = `[${timestamp}] [${level}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`
      await appendFile(logFile, line, 'utf-8')
    } catch {
      // Silently fail on file logging errors
    }
  }
}

/**
 * Create a console-only logger.
 */
export function createConsoleLogger(): Logger {
  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      console.log(formatMessage('INFO', message, meta))
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      console.warn(formatMessage('WARN', message, meta))
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      console.error(formatMessage('ERROR', message, meta))
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (process.env.MT_DEBUG) {
        console.debug(formatMessage('DEBUG', message, meta))
      }
    },
  }
}

function formatMessage(level: string, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString().slice(11, 23)
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
  return `${timestamp} [${level}] ${message}${metaStr}`
}
