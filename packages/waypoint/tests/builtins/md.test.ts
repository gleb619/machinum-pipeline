import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMdSource, createMdTarget } from '../../src/md.js'

import '../../src/md.js'

describe('md source', () => {
  let tempDir: string
  let filePath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'md-test-'))
    filePath = join(tempDir, 'test.md')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should read markdown file and yield its contents', async () => {
    const content = '# Hello\n\nThis is a test markdown file.'
    writeFileSync(filePath, content, 'utf-8')

    const uri: any = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    const results = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0]!.item).toBe(content)
  })

  it('should support resume by re-reading the file', async () => {
    const content = '# Resume Test'
    writeFileSync(filePath, content, 'utf-8')

    const uri: any = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    const results = []
    for await (const env of source.resume!(ctx, 0)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0]!.item).toBe(content)
  })

  it('should read all .md files from a directory recursively', async () => {
    const subDir = join(tempDir, 'docs', 'guides')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(tempDir, 'intro.md'), '# Intro', 'utf-8')
    writeFileSync(join(subDir, 'getting-started.md'), '# Getting Started', 'utf-8')
    writeFileSync(join(subDir, 'advanced.md'), '# Advanced', 'utf-8')

    const uri: any = {
      raw: `md://${tempDir}`,
      host: tempDir,
      path: tempDir,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    const results = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(3)
    expect(results.map((r) => r.meta.filePath).sort()).toEqual([
      join(tempDir, 'docs', 'guides', 'advanced.md'),
      join(tempDir, 'docs', 'guides', 'getting-started.md'),
      join(tempDir, 'intro.md'),
    ])
    expect(results[0]!.item).toBe('# Advanced')
    expect(results[1]!.item).toBe('# Getting Started')
    expect(results[2]!.item).toBe('# Intro')
  })
})

describe('md target', () => {
  let tempDir: string
  let filePath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'md-test-'))
    filePath = join(tempDir, 'out.md')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should append markdown content to file', async () => {
    const uri: any = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    await target.open(ctx)
    await target.write({ item: '# Line 1', meta: {} }, ctx)
    await target.write({ item: '# Line 2', meta: {} }, ctx)
    await target.close(ctx)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toBe('# Line 1\n# Line 2\n')
  })

  it('should throw if write is called before open', async () => {
    const uri: any = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    await expect(target.write({ item: 'x', meta: {} }, ctx)).rejects.toThrow(
      'Target not opened. Call open() before write().',
    )
  })

  it('should write chapter1.md, chapter2.md when given two envelopes without meta.chapterNum', async () => {
    const dir = join(tempDir, 'output')
    const uri: any = {
      raw: `md://${dir}`,
      host: dir,
      path: dir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    await target.open(ctx)
    await target.write({ item: '# Chapter 1', meta: {} }, ctx)
    await target.write({ item: '# Chapter 2', meta: {} }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(dir, 'chapter1.md'), 'utf-8')).toBe('# Chapter 1')
    expect(readFileSync(join(dir, 'chapter2.md'), 'utf-8')).toBe('# Chapter 2')
  })

  it('should use meta.chapterNum for filenames in directory mode', async () => {
    const dir = join(tempDir, 'output')
    const uri: any = {
      raw: `md://${dir}`,
      host: dir,
      path: dir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    await target.open(ctx)
    await target.write({ item: '# First', meta: { chapterNum: 5 } }, ctx)
    await target.write({ item: '# Second', meta: { chapter: 10 } }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(dir, 'chapter5.md'), 'utf-8')).toBe('# First')
    expect(readFileSync(join(dir, 'chapter10.md'), 'utf-8')).toBe('# Second')
  })

  it('should write files from meta.mdOutputs and ignore base path', async () => {
    const baseDir = join(tempDir, 'ignored')
    const targetDir = join(tempDir, 'custom')
    const uri: any = {
      raw: `md://${baseDir}`,
      host: baseDir,
      path: baseDir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = { run: { global: { settings: {} } } } as any
    await target.open(ctx)
    await target.write(
      {
        item: 'should be ignored',
        meta: {
          mdOutputs: [
            { dir: targetDir, filename: 'intro.md', content: '# Custom Intro' },
            { dir: targetDir, filename: 'outro.md', content: '# Custom Outro' },
          ],
        },
      },
      ctx,
    )
    await target.close(ctx)

    expect(readFileSync(join(targetDir, 'intro.md'), 'utf-8')).toBe('# Custom Intro')
    expect(readFileSync(join(targetDir, 'outro.md'), 'utf-8')).toBe('# Custom Outro')
    expect(() => readFileSync(join(baseDir, 'chapter1.md'), 'utf-8')).toThrow()
  })
})
