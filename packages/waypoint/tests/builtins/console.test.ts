import type { Exchange, ParsedUri, TargetContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleTarget, renderConsoleExchange } from '../../src/console.js'

const ctx = { run: { global: { settings: {} } } } as TargetContext

function makeUri(query: Record<string, string> = {}): ParsedUri {
  return {
    scheme: 'console',
    raw: 'console://',
    host: '',
    path: '',
    query,
    fragment: '',
  }
}

function makeEnv(overrides: Partial<Exchange<unknown>> = {}): Exchange<unknown> {
  return {
    id: 'ex-1',
    item: 'hello',
    meta: { chapterId: 'ch-1' },
    variables: [],
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderConsoleExchange', () => {
  it('renders a raw string as-is with auto format', () => {
    expect(renderConsoleExchange(makeEnv({ item: 'hello' }))).toBe('hello\n')
  })

  it('renders an object as compact JSON with auto format', () => {
    expect(renderConsoleExchange(makeEnv({ item: { a: 1, b: [2] } }))).toBe('{"a":1,"b":[2]}\n')
  })

  it('quotes strings with json format', () => {
    expect(renderConsoleExchange(makeEnv({ item: 'hello' }), { format: 'json' })).toBe('"hello"\n')
  })

  it('indents with pretty format', () => {
    expect(renderConsoleExchange(makeEnv({ item: { a: 1 } }), { format: 'pretty' })).toBe(
      '{\n  "a": 1\n}\n',
    )
  })

  it('applies the prefix to every line of a multi-line item', () => {
    expect(renderConsoleExchange(makeEnv({ item: 'one\ntwo' }), { prefix: '> ' })).toBe(
      '> one\n> two\n',
    )
  })

  it('keeps exactly one trailing newline', () => {
    expect(renderConsoleExchange(makeEnv({ item: 'hello\n\n' }))).toBe('hello\n')
  })

  it('renders the full envelope when requested and omits undefined items', () => {
    expect(renderConsoleExchange(makeEnv(), { envelope: true, format: 'json' })).toBe(
      '{"id":"ex-1","item":"hello","meta":{"chapterId":"ch-1"},"variables":[]}\n',
    )
  })

  it('includes items in the envelope when defined', () => {
    const rendered = renderConsoleExchange(makeEnv({ item: ['a'], items: ['a'] }), {
      envelope: true,
      format: 'json',
    })
    expect(rendered).toBe(
      '{"id":"ex-1","item":["a"],"items":["a"],"meta":{"chapterId":"ch-1"},"variables":[]}\n',
    )
  })
})

describe('console target', () => {
  it('writes immediately through the injected sink', async () => {
    const chunks: string[] = []
    const target = createConsoleTarget<string>(makeUri(), { sink: (chunk) => chunks.push(chunk) })

    await target.open(ctx)
    await target.write(makeEnv({ item: 'first' }), ctx)
    expect(chunks).toEqual(['first\n'])
    await target.close(ctx)
    expect(chunks).toEqual(['first\n'])
  })

  it('routes writes to stderr when stream=stderr', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk: string | Uint8Array) => true)
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((_chunk: string | Uint8Array) => true)
    const target = createConsoleTarget<string>(makeUri({ stream: 'stderr' }))

    await target.open(ctx)
    await target.write(makeEnv({ item: 'oops' }), ctx)
    await target.close(ctx)

    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls[0]?.[0]).toBe('oops\n')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('lets factory options override URI query values', async () => {
    const chunks: string[] = []
    const target = createConsoleTarget<string>(makeUri({ format: 'json', prefix: 'old ' }), {
      format: 'pretty',
      prefix: 'new ',
      sink: (chunk) => chunks.push(chunk),
    })

    await target.write(makeEnv({ item: { a: 1 } }), ctx)
    expect(chunks).toEqual(['new {\nnew   "a": 1\nnew }\n'])
  })

  it('throws at factory time for an unknown format', () => {
    expect(() => createConsoleTarget(makeUri({ format: 'xml' }))).toThrow(
      "Invalid console:// format 'xml'. Expected one of: auto, json, pretty",
    )
  })

  it('throws at factory time for an unknown stream', () => {
    expect(() => createConsoleTarget(makeUri({ stream: 'file' }))).toThrow(
      "Invalid console:// stream 'file'. Expected one of: stdout, stderr",
    )
  })

  it('has no checkpoint hook', () => {
    expect(createConsoleTarget(makeUri()).checkpoint).toBeUndefined()
  })
})
