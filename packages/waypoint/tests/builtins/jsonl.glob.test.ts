import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedUri, SourceContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createJsonlSource } from '../../src/jsonl.js'

describe('jsonl glob source', () => {
  it('reads multiple files matching a glob pattern', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-jsonl-glob-'))
    await writeFile(join(dir, 'a.jsonl'), '{"item":"a","meta":{}}\n')
    await writeFile(join(dir, 'b.jsonl'), '{"item":"b","meta":{}}\n')

    const uri: ParsedUri = {
      scheme: 'jsonl',
      raw: `jsonl://${dir}/*.jsonl`,
      host: '',
      path: `${dir}/*.jsonl`,
      query: {},
      fragment: '',
    }
    const source = createJsonlSource(uri)

    const ctx = { run: { global: { settings: {} } } } as SourceContext
    const results: unknown[] = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(2)
    expect(results.map((r) => r.item)).toContain('a')
    expect(results.map((r) => r.item)).toContain('b')

    rmSync(dir, { recursive: true, force: true })
  })
})
