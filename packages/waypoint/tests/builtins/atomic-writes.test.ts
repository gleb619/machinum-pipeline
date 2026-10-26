import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChapterOutputTarget } from '../../src/chapter-output.js'
import { createJsonlTarget } from '../../src/jsonl.js'
import { createMdTarget } from '../../src/md.js'
import { createSchemaDocTarget } from '../../src/schema-doc.js'

import '../../src/chapter-output.js'
import '../../src/jsonl.js'
import '../../src/md.js'
import '../../src/schema-doc.js'

/**
 * Contract under test (CLAUDE.md hard rule): file writes are atomic — temp-then-rename.
 * A crash mid-run must never leave a partial final file, and a rerun must not
 * duplicate lines into it.
 */
function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).includes('.tmp.'))
}

describe('waypoint targets — atomic writes', () => {
  let tempDir: string
  let ctx: TargetContext

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mt-atomic-wp-'))
    ctx = { run: { runId: 'run-1', global: { settings: {} } } } as unknown as TargetContext
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('md target (file mode)', () => {
    it('leaves no final file when the run is abandoned before close()', async () => {
      const file = join(tempDir, 'out.md')
      const target = createMdTarget<string>({
        scheme: 'md',
        raw: `md://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# Chapter 1', meta: {} }, ctx)

      expect(existsSync(file)).toBe(false)
    })

    it('publishes the file on close()', async () => {
      const file = join(tempDir, 'out.md')
      const target = createMdTarget<string>({
        scheme: 'md',
        raw: `md://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# Chapter 1', meta: {} }, ctx)
      await target.write({ item: '# Chapter 2', meta: {} }, ctx)
      await target.close(ctx)

      expect(readFileSync(file, 'utf-8')).toBe('# Chapter 1\n# Chapter 2\n')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })

    it('rerun does not duplicate lines', async () => {
      const file = join(tempDir, 'out.md')
      const uri = {
        scheme: 'md',
        raw: `md://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      }

      for (const runId of ['run-1', 'run-2']) {
        const target = createMdTarget<string>(uri)
        const runCtx = {
          run: { runId, global: { settings: {} } },
        } as unknown as TargetContext
        await target.open(runCtx)
        await target.write({ item: '# Chapter 1', meta: {} }, runCtx)
        await target.write({ item: '# Chapter 2', meta: {} }, runCtx)
        await target.close(runCtx)
      }

      expect(readFileSync(file, 'utf-8')).toBe('# Chapter 1\n# Chapter 2\n')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })

    it('a rerun replaces content left by a crashed run', async () => {
      const file = join(tempDir, 'out.md')
      writeFileSync(file, '# stale half-written chapter\n', 'utf-8')
      writeFileSync(`${file}.tmp.run-0`, '# partial', 'utf-8')

      const target = createMdTarget<string>({
        scheme: 'md',
        raw: `md://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      })
      await target.open(ctx)
      await target.write({ item: '# fresh', meta: {} }, ctx)
      await target.close(ctx)

      expect(readFileSync(file, 'utf-8')).toBe('# fresh\n')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })
  })

  describe('md target (dir mode)', () => {
    it('writes each chapter atomically', async () => {
      const dir = join(tempDir, 'chapters')
      const target = createMdTarget<string>({
        scheme: 'md',
        raw: `md://${dir}`,
        host: dir,
        path: dir,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# One', meta: { chapterNum: 1 } }, ctx)
      await target.write(
        { item: '# Two', meta: { mdOutputs: [{ subdir: '', filename: 'x.md', content: '# X' }] } },
        ctx,
      )
      await target.close(ctx)

      expect(readFileSync(join(dir, 'chapter1.md'), 'utf-8')).toBe('# One')
      expect(readFileSync(join(dir, 'x.md'), 'utf-8')).toBe('# X')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })
  })

  describe('jsonl target', () => {
    it('leaves no final file when the run is abandoned before close()', async () => {
      const file = join(tempDir, 'out.jsonl')
      const target = createJsonlTarget<unknown>({
        scheme: 'jsonl',
        raw: `jsonl://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: 'a', meta: {} }, ctx)

      expect(existsSync(file)).toBe(false)
    })

    it('publishes one line per envelope on close()', async () => {
      const file = join(tempDir, 'out.jsonl')
      const target = createJsonlTarget<unknown>({
        scheme: 'jsonl',
        raw: `jsonl://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: 'a', meta: {} }, ctx)
      await target.write({ item: 'b', meta: {} }, ctx)
      await target.close(ctx)

      const lines = readFileSync(file, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines.map((l) => JSON.parse(l).item)).toEqual([undefined, undefined])
      expect(
        lines.map(
          (l) => JSON.parse(l).variables.find((v: { name: string }) => v.name === 'item').value,
        ),
      ).toEqual(['a', 'b'])
      expect(tmpFilesIn(tempDir)).toEqual([])
    })

    it('rerun does not duplicate lines', async () => {
      const file = join(tempDir, 'out.jsonl')
      const uri = {
        scheme: 'jsonl',
        raw: `jsonl://${file}`,
        host: file,
        path: file,
        fragment: '',
        query: {},
      }

      for (const runId of ['run-1', 'run-2']) {
        const target = createJsonlTarget<unknown>(uri)
        const runCtx = {
          run: { runId, global: { settings: {} } },
        } as unknown as TargetContext
        await target.open(runCtx)
        await target.write({ item: 'a', meta: {} }, runCtx)
        await target.close(runCtx)
      }

      expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1)
      expect(tmpFilesIn(tempDir)).toEqual([])
    })
  })

  describe('chapter-output target', () => {
    it('writes each chapter file atomically', async () => {
      const dir = join(tempDir, 'chapters')
      const target = createChapterOutputTarget<string>({
        scheme: 'chapter-output',
        raw: `chapter-output://${dir}`,
        host: dir,
        path: dir,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# One', meta: { lang: 'en', chapterNum: 1 } }, ctx)
      await target.close(ctx)

      expect(readFileSync(join(dir, 'en', 'chapter1.md'), 'utf-8')).toBe('# One')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })

    it('replaces a truncated chapter left by a crash', async () => {
      const dir = join(tempDir, 'chapters')
      const target = createChapterOutputTarget<string>({
        scheme: 'chapter-output',
        raw: `chapter-output://${dir}`,
        host: dir,
        path: dir,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# One', meta: { chapterNum: 1 } }, ctx)
      await target.write({ item: '# One rewritten', meta: { chapterNum: 1 } }, ctx)
      await target.close(ctx)

      expect(readFileSync(join(dir, 'chapter1.md'), 'utf-8')).toBe('# One rewritten')
    })
  })

  describe('schema-doc target', () => {
    it('writes each schema doc atomically', async () => {
      const dir = join(tempDir, 'schema')
      const target = createSchemaDocTarget({
        scheme: 'schema-doc',
        raw: `schema-doc://${dir}`,
        host: dir,
        path: dir,
        fragment: '',
        query: {},
      })

      await target.open(ctx)
      await target.write({ item: '# Chapter One', meta: { chapterNum: 1 } }, ctx)
      await target.close(ctx)

      const written = join(dir, 'chapter1.schema.md')
      expect(readFileSync(written, 'utf-8')).toContain('# Chapter One')
      expect(tmpFilesIn(tempDir)).toEqual([])
    })
  })
})
