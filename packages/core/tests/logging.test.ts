import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleLogger, escapeLogNewlines, formatLogLine } from '../src/logging.js'

const INFO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] hello$/

describe('escapeLogNewlines', () => {
  it('escapes LF, CRLF and TAB', () => {
    expect(escapeLogNewlines('a\nb\r\nc\td')).toBe('a\\nb\\nc\\td')
  })

  it('escapes a lone CR', () => {
    expect(escapeLogNewlines('a\rb')).toBe('a\\nb')
  })

  it('escapes other control characters', () => {
    expect(escapeLogNewlines('a\u0000b\u007fc')).toBe('a\\u0000b\\u007fc')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLogNewlines('plain text 123')).toBe('plain text 123')
  })
})

describe('formatLogLine', () => {
  it('formats an INFO line without meta', () => {
    expect(formatLogLine('info', 'hello')).toMatch(INFO_LINE)
  })

  it('builds the exact line shape', () => {
    expect(formatLogLine('info', 'hello', undefined, '2026-11-03T11:23:29.471Z')).toBe(
      '2026-11-03T11:23:29.471Z [INFO] hello',
    )
  })

  it('tags warn, error and debug', () => {
    expect(formatLogLine('warn', 'hello')).toContain(' [WARN] hello')
    expect(formatLogLine('error', 'hello')).toContain(' [ERROR] hello')
    expect(formatLogLine('debug', 'hello')).toContain(' [DEBUG] hello')
  })

  it('appends meta as compact JSON', () => {
    const line = formatLogLine('info', 'hello', { a: 1, b: 'two' })
    expect(line.endsWith(' {"a":1,"b":"two"}')).toBe(true)
  })

  it('omits meta when it is empty or absent', () => {
    expect(formatLogLine('info', 'hello', {})).not.toContain('{')
    expect(formatLogLine('info', 'hello')).not.toContain('{')
  })

  it('renders a Date timestamp as ISO-8601 UTC', () => {
    const line = formatLogLine('info', 'hello', undefined, new Date('2026-11-03T11:23:29.471Z'))
    expect(line.startsWith('2026-11-03T11:23:29.471Z [INFO] hello')).toBe(true)
  })

  it('uses a string timestamp as-is', () => {
    expect(formatLogLine('info', 'hello', undefined, 'STAMP')).toBe('STAMP [INFO] hello')
  })

  it('never contains a raw newline', () => {
    const line = formatLogLine('info', 'first\nsecond\r\nthird')
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
  })
})

describe('createConsoleLogger', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('writes info, warn and error as a single string argument', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createConsoleLogger()
    logger.info('hello')
    logger.warn('careful')
    logger.error('broken')

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.length).toBe(1)
    expect(typeof log.mock.calls[0]?.[0]).toBe('string')
    expect(log.mock.calls[0]?.[0]).toMatch(INFO_LINE)
    expect(warn.mock.calls[0]?.length).toBe(1)
    expect(warn.mock.calls[0]?.[0]).toContain(' [WARN] careful')
    expect(error.mock.calls[0]?.length).toBe(1)
    expect(error.mock.calls[0]?.[0]).toContain(' [ERROR] broken')
  })

  it('keeps debug output quiet unless it is enabled', () => {
    vi.stubEnv('MT_DEBUG', '')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    createConsoleLogger().debug('quiet')
    expect(debug).not.toHaveBeenCalled()
  })

  it('emits debug output when MT_DEBUG is set', () => {
    vi.stubEnv('MT_DEBUG', '1')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    createConsoleLogger().debug('loud')
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0]?.[0]).toContain(' [DEBUG] loud')
  })

  it('emits debug output when the debug option is set', () => {
    vi.stubEnv('MT_DEBUG', '')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    createConsoleLogger({ debug: true }).debug('loud')
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
