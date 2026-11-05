import type { Logger } from './types.js'

/** Log severities emitted by the shared formatter. */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error'

/**
 * Log output format: `text` is the human/markdown-safe line format (default);
 * `json` emits one JSON object per line (JSONL) for machines.
 */
export type LogFormat = 'text' | 'json'

/**
 * Escape the markdown constructs that would change how a log message renders when
 * viewed with a Markdown renderer (links, HTML-ish tags, emphasis). Line-level
 * constructs (#, >, -, 1.) cannot trigger because every line starts with the
 * ISO timestamp; identifiers such as `MT_EMBED_PASSWORD` and JSON arrays stay
 * readable.
 */
function escapeMarkdownLine(line: string): string {
  let out = line
  out = out.replace(/\*/g, '\\*')
  out = out.replace(/\[(?=[^\]]*\]\()/g, '\\[')
  out = out.replace(/<(?=[a-zA-Z/])/g, '\\<')
  return out
}

/** Escape markdown special characters per line of a (possibly multi-line) message. */
export function escapeMarkdown(text: string): string {
  return text.split('\n').map(escapeMarkdownLine).join('\n')
}

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
  // Markdown-escape before newline escaping: `escapeLogNewlines` must emit the literal
  // two characters `\n`, not a backslash that markdown escaping would double.
  return `${ts} [${String(level).toUpperCase()}] ${escapeLogNewlines(escapeMarkdown(message))}${metaPart}`
}

/**
 * Build one JSONL log line: `{"ts":<ISO8601>,"level":"info","message":"...","meta":{...}}`.
 * `meta` is nested (and omitted when empty) so it cannot collide with envelope keys.
 * Multi-line messages stay raw inside the JSON string — JSONL is a machine format.
 */
export function formatJsonLogLine(
  level: LogSeverity | string,
  message: string,
  meta?: Record<string, unknown>,
  timestamp?: Date | string,
): string {
  const ts =
    timestamp instanceof Date ? timestamp.toISOString() : (timestamp ?? new Date().toISOString())
  const record: { ts: string; level: string; message: string; meta?: Record<string, unknown> } = {
    ts,
    level: String(level).toLowerCase(),
    message,
  }
  if (meta && Object.keys(meta).length > 0) record.meta = meta
  return JSON.stringify(record)
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
export function createConsoleLogger(options?: {
  debug?: boolean
  format?: LogFormat
}): Logger {
  const debugEnabled = (): boolean => options?.debug === true || Boolean(process.env.MT_DEBUG)
  const line = (level: LogSeverity, message: string, meta?: Record<string, unknown>): string =>
    options?.format === 'json'
      ? formatJsonLogLine(level, message, meta)
      : formatLogLine(level, message, meta)
  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      console.log(line('info', message, meta))
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      console.warn(line('warn', message, meta))
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      console.error(line('error', message, meta))
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (debugEnabled()) console.debug(line('debug', message, meta))
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
