import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createConsoleLogger,
  escapeLogNewlines,
  escapeMarkdown,
  formatJsonLogLine,
  formatLogLine,
  log,
} from '../src/logging.js'

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

  it('markdown-escapes the message but keeps meta as compact JSON', () => {
    const line = formatLogLine('info', '# heading with *stars* [x](y)', { a: 'b|c' })
    expect(line).toContain(' # heading with \\*stars\\* \\[x](y) ')
    expect(line).toContain(' {"a":"b|c"}')
  })

  it('escapes markdown before newline escaping so \\n stays literal', () => {
    const line = formatLogLine('info', 'first\nsecond')
    expect(line).toContain('first\\nsecond')
  })
})

describe('escapeMarkdown', () => {
  it('escapes emphasis, links and HTML tags', () => {
    expect(escapeMarkdown('*bold* [x](y) <tag> a|b _em_')).toBe(
      '\\*bold\\* \\[x](y) \\<tag> a|b _em_',
    )
  })

  it('leaves identifiers, arrays and block markers alone', () => {
    expect(escapeMarkdown('MT_EMBED_PASSWORD {"a":[2,3]}')).toBe('MT_EMBED_PASSWORD {"a":[2,3]}')
    expect(escapeMarkdown('# heading')).toBe('# heading')
    expect(escapeMarkdown('- item')).toBe('- item')
  })

  it('escapes each line independently', () => {
    expect(escapeMarkdown('plain\n*second* line')).toBe('plain\n\\*second\\* line')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeMarkdown('Pipeline completed successfully (runId: abc)')).toBe(
      'Pipeline completed successfully (runId: abc)',
    )
  })
})

describe('formatJsonLogLine', () => {
  it('emits ts/level/message/meta as one JSON object', () => {
    const record = JSON.parse(
      formatJsonLogLine('INFO', 'hello', { key: 'value' }, '2026-11-03T11:23:29.471Z'),
    ) as Record<string, unknown>
    expect(record).toEqual({
      ts: '2026-11-03T11:23:29.471Z',
      level: 'info',
      message: 'hello',
      meta: { key: 'value' },
    })
  })

  it('omits meta when absent or empty', () => {
    expect(formatJsonLogLine('info', 'hello')).not.toContain('meta')
    expect(formatJsonLogLine('info', 'hello', {})).not.toContain('meta')
  })

  it('does not markdown-escape or newline-escape the message', () => {
    const record = JSON.parse(formatJsonLogLine('info', '# raw *text*\nsecond')) as {
      message: string
    }
    expect(record.message).toBe('# raw *text*\nsecond')
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

describe('log', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('defaults to INFO with a single console argument', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('hello')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.length).toBe(1)
    expect(spy.mock.calls[0]?.[0]).toMatch(INFO_LINE)
  })

  it('passes meta through as compact JSON', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('hello', { a: 1 })
    expect(spy.mock.calls[0]?.[0]).toMatch(/ \[INFO\] hello \{"a":1\}$/)
  })

  it('emits a [WARN] line via log.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.warn('careful')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.length).toBe(1)
    expect(spy.mock.calls[0]?.[0]).toContain(' [WARN] careful')
  })

  it('escapes newlines inside the message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('first\nsecond')
    const line = spy.mock.calls[0]?.[0] as string
    expect(line).not.toContain('\n')
    expect(line).toContain('first\\nsecond')
  })

  it('exposes info/warn/error/debug like the console logger', () => {
    for (const method of ['info', 'warn', 'error', 'debug'] as const) {
      expect(typeof log[method]).toBe('function')
    }
  })
})
