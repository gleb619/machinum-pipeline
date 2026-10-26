import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope, ParsedUri, SourceContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChapterOutputSource } from '../../src/chapter-output.js'
import { createEphemeralSource, createEphemeralTarget } from '../../src/ephemeral.js'
import { createMdSource } from '../../src/md.js'
import { createSchemaDocSource } from '../../src/schema-doc.js'

const ctx = {
  run: { global: { project: { name: 'test', root: tmpdir() }, settings: {} } },
} as unknown as SourceContext

function ephemeralUri(name: string): ParsedUri {
  return { raw: `ephemeral://${name}`, host: name, path: name, query: {} }
}

function fileUri(scheme: string, path: string): ParsedUri {
  return { raw: `${scheme}://${path}`, host: path, path, query: {} }
}

async function collect<T>(iterable: AsyncIterable<Envelope<T>>): Promise<Envelope<T>[]> {
  const out: Envelope<T>[] = []
  for await (const env of iterable) out.push(env)
  return out
}

describe('resumable sources honor the resume cursor (T098)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resume-skip-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('md:// dir source: resume(ctx, 2) yields only the tail after 2 envelopes', async () => {
    writeFileSync(join(tempDir, 'a.md'), '# A', 'utf-8')
    writeFileSync(join(tempDir, 'b.md'), '# B', 'utf-8')
    writeFileSync(join(tempDir, 'c.md'), '# C', 'utf-8')

    const source = createMdSource<string>(fileUri('md', tempDir))
    if (!source.resume) throw new Error('resume not supported')

    const all = await collect(source.start(ctx))
    expect(all.map((e) => e.item)).toEqual(['# A', '# B', '# C'])

    const tail = await collect(source.resume(ctx, 2))
    expect(tail.map((e) => e.item)).toEqual(['# C'])
  })

  it('md:// dir source: non-number cursor replays from the start', async () => {
    writeFileSync(join(tempDir, 'a.md'), '# A', 'utf-8')
    writeFileSync(join(tempDir, 'b.md'), '# B', 'utf-8')

    const source = createMdSource<string>(fileUri('md', tempDir))
    if (!source.resume) throw new Error('resume not supported')

    const replayed = await collect(source.resume(ctx, 'oops'))
    expect(replayed.map((e) => e.item)).toEqual(['# A', '# B'])
  })

  it('chapter-output:// source: resume(ctx, 2) yields only the tail after 2 envelopes', async () => {
    mkdirSync(join(tempDir, 'en'), { recursive: true })
    writeFileSync(join(tempDir, 'en', 'chapter1.md'), '# Ch 1', 'utf-8')
    writeFileSync(join(tempDir, 'en', 'chapter2.md'), '# Ch 2', 'utf-8')
    writeFileSync(join(tempDir, 'en', 'chapter3.md'), '# Ch 3', 'utf-8')

    const source = createChapterOutputSource<string>(fileUri('chapter-output', tempDir))
    if (!source.resume) throw new Error('resume not supported')

    const tail = await collect(source.resume(ctx, 2))
    expect(tail).toHaveLength(1)
    expect(tail[0]?.item).toBe('# Ch 3')
    expect(tail[0]?.meta.chapterNum).toBe(3)
  })

  it('ephemeral:// source: resume(ctx, 2) yields only the tail after 2 envelopes', async () => {
    const bufferUri = ephemeralUri('resume-skip-buffer')

    const target = createEphemeralTarget<number>(bufferUri)
    await target.open({} as never)
    await target.write({ item: 1, meta: {} }, {} as never)
    await target.write({ item: 2, meta: {} }, {} as never)
    await target.write({ item: 3, meta: {} }, {} as never)
    await target.close({} as never)

    const source = createEphemeralSource<number>(bufferUri)
    if (!source.resume) throw new Error('resume not supported')

    const all = await collect(source.start(ctx))
    expect(all.map((e) => e.item)).toEqual([1, 2, 3])

    const tail = await collect(source.resume(ctx, 2))
    expect(tail.map((e) => e.item)).toEqual([3])
  })

  it('schema-doc:// source: resume(ctx, 1) yields nothing (single item)', async () => {
    const filePath = join(tempDir, 'chapter1.schema.md')
    writeFileSync(
      filePath,
      [
        '# Chapter 1',
        '',
        '## Metadata',
        '',
        '| chapter | wordCount | tokenCount | charLength |',
        '|---------|-----------|------------|------------|',
        '| 1 | 10 | 12 | 50 |',
        '',
        '## Summary',
        '',
        'Test summary.',
        '',
      ].join('\n'),
      'utf-8',
    )

    const source = createSchemaDocSource(fileUri('schema-doc', filePath))
    if (!source.resume) throw new Error('resume not supported')

    const all = await collect(source.start(ctx))
    expect(all).toHaveLength(1)
    expect(all[0]?.item.title).toBe('Chapter 1')

    const skipped = await collect(source.resume(ctx, 1))
    expect(skipped).toHaveLength(0)

    const replayed = await collect(source.resume(ctx, 0))
    expect(replayed).toHaveLength(1)
  })
})
