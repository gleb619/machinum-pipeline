import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createJsonlSource, createJsonlTarget } from '../../src/jsonl.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
  }
})

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>()
  return {
    ...actual,
    createInterface: vi.fn(),
  }
})

describe('jsonl', () => {
  it('should emit items from source', async () => {
    const mockReadStream = new Readable()
    vi.mocked(fs.createReadStream).mockReturnValue(mockReadStream as any)

    // Simulate read line
    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(rlMock as any)

    const uri: any = {
      raw: 'jsonl://test.jsonl',
      host: 'test.jsonl',
      path: 'test.jsonl',
      query: {},
    }
    const source = createJsonlSource(uri)

    const ctx = { run: { global: { settings: {} } } } as any
    const results = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0].item).toBe('test')
  })

  it('applies defaultFolder setting to bare filename', async () => {
    const mockReadStream = new Readable()
    vi.mocked(fs.createReadStream).mockReturnValue(mockReadStream as any)

    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(rlMock as any)

    const uri: any = {
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
    } as any

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
    vi.mocked(fs.createReadStream).mockReturnValue(mockReadStream as any)

    const rlMock = {
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({ item: 'test' })
      },
    }
    vi.mocked(readline.createInterface).mockReturnValue(rlMock as any)

    const uri: any = {
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
    } as any

    for await (const _ of source.start(ctx)) {
      // drain
    }

    expect(fs.createReadStream).toHaveBeenCalledWith(
      expect.stringContaining('./data/test.jsonl'),
      expect.anything(),
    )
  })

  it('applies defaultFolder to jsonl target', async () => {
    const mockWriteStream = {
      write: vi.fn(),
      end: vi.fn(),
    }
    vi.mocked(fs.createWriteStream).mockReturnValue(mockWriteStream as any)

    const uri: any = {
      raw: 'jsonl://out.jsonl',
      host: 'out.jsonl',
      path: 'out.jsonl',
      query: {},
    }
    const target = createJsonlTarget(uri)

    const ctx = {
      run: {
        global: {
          settings: { 'waypoint.jsonl.defaultFolder': './custom/jsonl' },
        },
      },
    } as any

    await target.open(ctx)

    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining('custom/jsonl/out.jsonl'),
      expect.anything(),
    )
  })
})
