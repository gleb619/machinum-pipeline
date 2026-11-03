import type { Logger } from './types.js'

/** Log severities emitted by the shared formatter. */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error'

/**
 * Escape CR/LF as the literal two characters `\n` and TAB as `\t`.
 *
 * Every other raw control character becomes a `\uXXXX` escape. One log call
 * must stay one physical line, so a newline inside a message is folded into
 * its escape rather than splitting the line. A CRLF pair counts as one line
 * break and yields a single `\n`.
 */
export function escapeLogNewlines(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    const code = char.charCodeAt(0)
    if (char === '\r') {
      if (text.charAt(i + 1) === '\n') i++
      out += '\\n'
    } else if (char === '\n') {
      out += '\\n'
    } else if (char === '\t') {
      out += '\\t'
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return out
}

/**
 * Build one log line: `<ISO-8601 UTC timestamp> [<LEVEL>] <message>[ <meta>]`.
 *
 * The message is escaped so the line stays single-line; `meta` is appended as
 * compact JSON only when it carries at least one key.
 */
export function formatLogLine(
  level: LogSeverity | string,
  message: string,
  meta?: Record<string, unknown>,
  timestamp?: Date | string,
): string {
  const ts =
    timestamp instanceof Date ? timestamp.toISOString() : (timestamp ?? new Date().toISOString())
  const metaPart = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
  return `${ts} [${String(level).toUpperCase()}] ${escapeLogNewlines(message)}${metaPart}`
}

/**
 * Callable console-backed logger. The default call is INFO; the named methods
 * mirror {@link Logger}. Every path emits the shared line format with exactly
 * one console argument, and `.debug` is gated on `MT_DEBUG` (or `options.debug`
 * of the underlying console logger).
 */
export interface LogFunction extends Logger {
  (message: string, meta?: Record<string, unknown>): void
}

/**
 * Console-backed {@link Logger} emitting the shared line format.
 *
 * Every call passes exactly one string to the console method, so the formatted
 * line is never split across console arguments. Debug output is gated on
 * `options.debug` or a truthy `MT_DEBUG`.
 */
export function createConsoleLogger(options?: { debug?: boolean }): Logger {
  const debugEnabled = (): boolean => options?.debug === true || Boolean(process.env.MT_DEBUG)
  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      console.log(formatLogLine('info', message, meta))
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      console.warn(formatLogLine('warn', message, meta))
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      console.error(formatLogLine('error', message, meta))
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (debugEnabled()) console.debug(formatLogLine('debug', message, meta))
    },
  }
}

const consoleLogger = createConsoleLogger()

/**
 * Process-level singleton for pipeline code — no `ctx` needed. `log(message,
 * meta?)` emits an INFO line; `log.info/warn/error/debug` behave like the
 * underlying {@link createConsoleLogger}. Use in place of bare `console.log`.
 */
export const log: LogFunction = Object.assign(
  (message: string, meta?: Record<string, unknown>) => consoleLogger.info(message, meta),
  consoleLogger,
)
