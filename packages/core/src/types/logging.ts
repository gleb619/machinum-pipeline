/**
 * Logger interface — used by the engine to emit log events.
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
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
