import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createJsonlSource } from '../../src/builtins/jsonl-source.js'

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

describe('jsonl-source', () => {
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

    const results = []
    for await (const env of source.start({} as any)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0]?.item).toBe('test')
  })
})
