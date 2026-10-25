import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Readable } from 'node:stream'
import type { Envelope, SourceContext, TargetContext } from '@mt/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJsonlSource, createJsonlTarget } from '../../src/jsonl.js'
import type { ParsedUri } from '../../src/uri.js'

// Default to the real implementations; individual tests override with
// mockReturnValue when they need to fake the filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    createWriteStream: vi.fn(actual.createWriteStream),
  }
})

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>()
  return {
    ...actual,
    createInterface: vi.fn(actual.createInterface),
  }
})

/** Minimal stand-in for the WriteStream AtomicStreamWriter drives. */
interface MockWriteStream {
  write: (chunk: string) => void
  end: () => void
  destroy: () => void
  on: () => void
  once: (event: string, cb: () => void) => MockWriteStream
}

describe('jsonl', () => {
  // Restore the real implementations between tests — earlier tests install
  // mockReturnValue overrides that would otherwise leak into real-file tests.
  beforeEach(async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualRl = await vi.importActual<typeof import('node:readline')>('node:readline')
    vi.mocked(fs.createReadStream).mockReset().mockImplementation(actualFs.createReadStream)
    vi.mocked(fs.createWriteStream).mockReset().mockImplementation(actualFs.createWriteStream)
    vi.mocked(readline.createInterface).mockReset().mockImplementation(actualRl.createInterface)
  })

  it('should emit items from source', async () => {
    const mockReadStream = new Readable()
    vi.mocked(fs.createReadStream).mockReturnValue(
      mockReadStream as unknown as ReturnType<typeof fs.createReadStream>,
    )

    // Simulate read line
    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(
      rlMock as unknown as ReturnType<typeof readline.createInterface>,
    )

    const uri: ParsedUri = {
      raw: 'jsonl://test.jsonl',
      host: 'test.jsonl',
      path: 'test.jsonl',
      query: {},
    }
    const source = createJsonlSource(uri)

    const ctx = { run: { global: { settings: {} } } } as SourceContext
    const results = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0].item).toBe('test')
  })

  it('applies defaultFolder setting to bare filename', async () => {
    const mockReadStream = new Readable()
    vi.mocked(fs.createReadStream).mockReturnValue(
      mockReadStream as unknown as ReturnType<typeof fs.createReadStream>,
    )

    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(
      rlMock as unknown as ReturnType<typeof readline.createInterface>,
    )

    const uri: ParsedUri = {
      raw: 'jsonl://test.jsonl',
      host: 'test.jsonl',
      path: 'test.jsonl',
      query: {},
    }
    const source = createJsonlSource(uri)

    const ctx = {
      run: {
        global: {
          settings: { 'waypoint.jsonl.defaultFolder': './custom/jsonl' },
        },
      },
    } as SourceContext

    for await (const _ of source.start(ctx)) {
      // drain
    }

    expect(fs.createReadStream).toHaveBeenCalledWith(
      expect.stringContaining('custom/jsonl/test.jsonl'),
      expect.anything(),
    )
  })

  it('does not apply defaultFolder when path already has directory', async () => {
    const mockReadStream = new Readable()
    vi.mocked(fs.createReadStream).mockReturnValue(
      mockReadStream as unknown as ReturnType<typeof fs.createReadStream>,
    )

    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(
      rlMock as unknown as ReturnType<typeof readline.createInterface>,
    )

    const uri: ParsedUri = {
      raw: 'jsonl://./data/test.jsonl',
      host: './data/test.jsonl',
      path: './data/test.jsonl',
      query: {},
    }
    const source = createJsonlSource(uri)

    const ctx = {
      run: {
        global: {
          settings: { 'waypoint.jsonl.defaultFolder': './custom/jsonl' },
        },
      },
    } as SourceContext

    for await (const _ of source.start(ctx)) {
      // drain
    }

    expect(fs.createReadStream).toHaveBeenCalledWith(
      expect.stringContaining('./data/test.jsonl'),
      expect.anything(),
    )
  })

  it('applies defaultFolder to jsonl target', async () => {
    const mockWriteStream: MockWriteStream = {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      // Opens synchronously so AtomicStreamWriter.open() can resolve.
      once: (event, cb) => {
        if (event === 'open') cb()
        return mockWriteStream
      },
    }
    vi.mocked(fs.createWriteStream).mockReturnValue(
      mockWriteStream as unknown as ReturnType<typeof fs.createWriteStream>,
    )

    const uri: ParsedUri = {
      raw: 'jsonl://out.jsonl',
      host: 'out.jsonl',
      path: 'out.jsonl',
      query: {},
    }
    const target = createJsonlTarget(uri)

    const ctx = {
      run: {
        runId: 'run-1',
        global: {
          settings: { 'waypoint.jsonl.defaultFolder': './custom/jsonl' },
        },
      },
    } as SourceContext

    await target.open(ctx)

    // Writes go to a sibling temp file, renamed onto the target on close().
    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining('custom/jsonl/out.jsonl.tmp.'),
      expect.anything(),
    )
  })

  describe('envelope validation', () => {
    const ctx = { run: { global: { settings: {} } } } as SourceContext

    function makeSource(file: string, query: Record<string, string> = {}) {
      const uri: ParsedUri = { raw: `jsonl://${file}`, host: file, path: file, query }
      return createJsonlSource<string>(uri)
    }

    it('rejects malformed JSON with file:line in the error', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'bad.jsonl')
      fs.writeFileSync(file, '{"item":"a"}\n\nnot json\n')

      const source = makeSource(file)
      await expect(async () => {
        for await (const _ of source.start(ctx)) {
          // drain
        }
      }).rejects.toThrow(`${file}:3`)
    })

    it('rejects a line without an "item" property', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'noitem.jsonl')
      fs.writeFileSync(file, '{"item":"a"}\n{"title":"x"}\n')

      const source = makeSource(file)
      await expect(async () => {
        for await (const _ of source.start(ctx)) {
          // drain
        }
      }).rejects.toThrow(`${file}:2`)
    })

    it('defaults a missing "meta" to an empty object', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'nometa.jsonl')
      fs.writeFileSync(file, '{"item":"a"}\n{"item":"b","meta":{"lineId":"l2"}}\n')

      const source = makeSource(file)
      const envelopes: Envelope<string>[] = []
      for await (const env of source.start(ctx)) envelopes.push(env)

      expect(envelopes[0].meta).toEqual({})
      expect(envelopes[1].meta).toEqual({ lineId: 'l2' })
    })
  })

  describe('resume', () => {
    const ctx = { run: { global: { settings: {} } } } as SourceContext

    function makeSource(file: string, query: Record<string, string> = {}) {
      const uri: ParsedUri = { raw: `jsonl://${file}`, host: file, path: file, query }
      return createJsonlSource<number>(uri)
    }

    async function collectBatches(envs: AsyncIterable<Envelope<number>>): Promise<number[][]> {
      const out: number[][] = []
      for await (const env of envs) out.push(env.items ?? [env.item])
      return out
    }

    it('with blank lines and batchSize=2 yields the tail of the full start output', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'data.jsonl')
      const lines = [
        '{"item":1}',
        '',
        '{"item":2}',
        '{"item":3}',
        '',
        '{"item":4}',
        '{"item":5}',
        '{"item":6}',
      ]
      fs.writeFileSync(file, `${lines.join('\n')}\n`)

      const source = makeSource(file, { batchSize: '2' })
      const startBatches = await collectBatches(source.start(ctx))
      expect(startBatches).toEqual([
        [1, 2],
        [3, 4],
        [5, 6],
      ])

      const resumeBatches = await collectBatches(source.resume(ctx, 2))
      expect(resumeBatches).toEqual(startBatches.slice(1))
    })

    it('throws "invalid jsonl cursor" for a non-numeric cursor', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'data.jsonl')
      fs.writeFileSync(file, '{"item":1}\n')

      const source = makeSource(file)
      await expect(collectBatches(source.resume(ctx, 'not-a-number'))).rejects.toThrow(
        'invalid jsonl cursor',
      )
    })
  })
})
