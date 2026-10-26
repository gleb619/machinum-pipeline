import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedUri, SourceContext, TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChapterOutputSource, createChapterOutputTarget } from '../../src/chapter-output.js'
import { createJsonlSource, createJsonlTarget } from '../../src/jsonl.js'
import { createSchemaDocSource, createSchemaDocTarget } from '../../src/schema-doc.js'

/**
 * T145 — relative waypoint paths anchor at `project.root`, never `process.cwd()`.
 * These tests chdir to a temp dir that is NOT the project root; with cwd-relative
 * resolution every relative URI would read/write under `otherCwd` instead.
 */
describe('waypoint paths resolve against project.root, not process.cwd()', () => {
  let projectRoot: string
  let otherCwd: string
  let savedCwd: string

  const uri = (scheme: string, path: string): ParsedUri => ({
    scheme,
    raw: `${scheme}://${path}`,
    host: path,
    path,
    query: {},
  })

  const ctx = (settings: Record<string, string> = {}) =>
    ({
      run: {
        runId: 'run-1',
        global: { project: { name: 'test', root: projectRoot }, settings },
      },
    }) as unknown as SourceContext & TargetContext

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'mt-t145-root-'))
    otherCwd = mkdtempSync(join(tmpdir(), 'mt-t145-cwd-'))
    savedCwd = process.cwd()
    process.chdir(otherCwd)
  })

  afterEach(() => {
    process.chdir(savedCwd)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(otherCwd, { recursive: true, force: true })
  })

  it('jsonl source reads a relative file under project.root', async () => {
    writeFileSync(join(projectRoot, 'in.jsonl'), '{"item":"a"}\n{"item":"b"}\n')

    const out: unknown[] = []
    for await (const env of createJsonlSource<string>(uri('jsonl', 'in.jsonl')).start(ctx())) {
      out.push(env.item)
    }

    expect(out).toEqual(['a', 'b'])
  })

  it('jsonl target writes a relative file under project.root', async () => {
    const target = createJsonlTarget<string>(uri('jsonl', 'out.jsonl'))
    const c = ctx()
    await target.open(c)
    await target.write({ item: 'x', meta: {} }, c)
    await target.close(c)

    // Payload persists only as the `item` variable (main dropped the top-level `item` field).
    expect(readFileSync(join(projectRoot, 'out.jsonl'), 'utf-8')).toContain(
      '"name":"item","qualifier":"new","value":"x"',
    )
    expect(existsSync(join(otherCwd, 'out.jsonl'))).toBe(false)
  })

  it('jsonl source anchors a relative glob under project.root', async () => {
    mkdirSync(join(projectRoot, 'data'))
    writeFileSync(join(projectRoot, 'data', 'a.jsonl'), '{"item":"a"}\n')

    const out: unknown[] = []
    for await (const env of createJsonlSource<string>(uri('jsonl', 'data/*.jsonl')).start(ctx())) {
      out.push(env.item)
    }

    expect(out).toEqual(['a'])
  })

  it('chapter-output target writes a relative dir under project.root', async () => {
    const target = createChapterOutputTarget<string>(uri('chapter-output', 'chapters'))
    const c = ctx()
    await target.open(c)
    await target.write({ item: '# Ch 1', meta: { lang: 'en', chapterNum: 1 } }, c)
    await target.close(c)

    expect(readFileSync(join(projectRoot, 'chapters', 'en', 'chapter1.md'), 'utf-8')).toBe('# Ch 1')
    expect(existsSync(join(otherCwd, 'chapters'))).toBe(false)
  })

  it('chapter-output source reads a relative dir under project.root', async () => {
    mkdirSync(join(projectRoot, 'chapters'))
    writeFileSync(join(projectRoot, 'chapters', 'chapter1.md'), '# Ch 1')

    const out: unknown[] = []
    for await (const env of createChapterOutputSource<string>(
      uri('chapter-output', 'chapters'),
    ).start(ctx())) {
      out.push(env.item)
    }

    expect(out).toEqual(['# Ch 1'])
  })

  it('schema-doc target writes a relative dir under project.root', async () => {
    const target = createSchemaDocTarget(uri('schema-doc', 'schema'))
    const c = ctx()
    await target.open(c)
    await target.write({ item: '# Ch 1\n', meta: { chapterNum: 1, summary: 'Sum.' } }, c)
    await target.close(c)

    expect(readFileSync(join(projectRoot, 'schema', 'chapter1.schema.md'), 'utf-8')).toContain(
      '# Ch 1',
    )
    expect(existsSync(join(otherCwd, 'schema'))).toBe(false)
  })

  it('schema-doc source reads a relative file under project.root', async () => {
    writeFileSync(
      join(projectRoot, 'chapter1.schema.md'),
      ['# Chapter 1', '', '## Summary', '', 'Hello.'].join('\n'),
    )

    const out: unknown[] = []
    for await (const env of createSchemaDocSource(uri('schema-doc', 'chapter1.schema.md')).start(
      ctx(),
    )) {
      out.push(env.item)
    }

    expect(out).toHaveLength(1)
    expect((out[0] as { title: string }).title).toBe('Chapter 1')
  })

  it('defaultFolder is joined under project.root, not the cwd', async () => {
    mkdirSync(join(projectRoot, 'sink'))
    const target = createJsonlTarget<string>(uri('jsonl', 'out.jsonl'))
    const c = ctx({ 'waypoint.jsonl.defaultFolder': 'sink' })
    await target.open(c)
    await target.write({ item: 'x', meta: {} }, c)
    await target.close(c)

    expect(readFileSync(join(projectRoot, 'sink', 'out.jsonl'), 'utf-8')).toContain(
      '"name":"item","qualifier":"new","value":"x"',
    )
    expect(existsSync(join(otherCwd, 'sink'))).toBe(false)
  })
})
