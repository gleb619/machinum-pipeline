import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMdSource, createMdTarget } from '../../src/md.js'
import type { ParsedUri } from '../../src/uri.js'

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

    const uri: ParsedUri = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    const results = []
    for await (const env of source.start(ctx)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0]?.item).toBe(content)
  })

  it('should support resume by re-reading the file', async () => {
    const content = '# Resume Test'
    writeFileSync(filePath, content, 'utf-8')

    const uri: ParsedUri = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    const results = []
    if (!source.resume) throw new Error('resume not supported')
    for await (const env of source.resume(ctx, 0)) {
      results.push(env)
    }

    expect(results).toHaveLength(1)
    expect(results[0]?.item).toBe(content)
  })

  it('should read all .md files from a directory recursively', async () => {
    const subDir = join(tempDir, 'docs', 'guides')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(tempDir, 'intro.md'), '# Intro', 'utf-8')
    writeFileSync(join(subDir, 'getting-started.md'), '# Getting Started', 'utf-8')
    writeFileSync(join(subDir, 'advanced.md'), '# Advanced', 'utf-8')

    const uri: ParsedUri = {
      raw: `md://${tempDir}`,
      host: tempDir,
      path: tempDir,
      query: {},
    }

    const source = createMdSource(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
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
    expect(results[0]?.item).toBe('# Advanced')
    expect(results[1]?.item).toBe('# Getting Started')
    expect(results[2]?.item).toBe('# Intro')
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
    const uri: ParsedUri = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    await target.open(ctx)
    await target.write({ item: '# Line 1', meta: {} }, ctx)
    await target.write({ item: '# Line 2', meta: {} }, ctx)
    await target.close(ctx)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toBe('# Line 1\n# Line 2\n')
  })

  it('should throw if write is called before open', async () => {
    const uri: ParsedUri = {
      raw: `md://${filePath}`,
      host: filePath,
      path: filePath,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    await expect(target.write({ item: 'x', meta: {} }, ctx)).rejects.toThrow(
      'Target not opened. Call open() before write().',
    )
  })

  it('should write chapter1.md, chapter2.md when given two envelopes without meta.chapterNum', async () => {
    const dir = join(tempDir, 'output')
    const uri: ParsedUri = {
      raw: `md://${dir}`,
      host: dir,
      path: dir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    await target.open(ctx)
    await target.write({ item: '# Chapter 1', meta: {} }, ctx)
    await target.write({ item: '# Chapter 2', meta: {} }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(dir, 'chapter1.md'), 'utf-8')).toBe('# Chapter 1')
    expect(readFileSync(join(dir, 'chapter2.md'), 'utf-8')).toBe('# Chapter 2')
  })

  it('should use meta.chapterNum for filenames in directory mode', async () => {
    const dir = join(tempDir, 'output')
    const uri: ParsedUri = {
      raw: `md://${dir}`,
      host: dir,
      path: dir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    await target.open(ctx)
    await target.write({ item: '# First', meta: { chapterNum: 5 } }, ctx)
    await target.write({ item: '# Second', meta: { chapter: 10 } }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(dir, 'chapter5.md'), 'utf-8')).toBe('# First')
    expect(readFileSync(join(dir, 'chapter10.md'), 'utf-8')).toBe('# Second')
  })

  it('should write files from meta.mdOutputs under the target root', async () => {
    const baseDir = join(tempDir, 'chapters')
    const uri: ParsedUri = {
      raw: `md://${baseDir}`,
      host: baseDir,
      path: baseDir,
      query: {},
    }

    const target = createMdTarget(uri)
    const ctx = {
      run: { global: { project: { name: 'test', root: tempDir }, settings: {} } },
    } as unknown as SourceContext
    await target.open(ctx)
    await target.write(
      {
        item: 'should be ignored',
        meta: {
          mdOutputs: [
            { name: 'intro', subdir: '', filename: 'intro.md', content: '# Custom Intro' },
            { name: 'outro', subdir: '', filename: 'outro.md', content: '# Custom Outro' },
          ],
        },
      },
      ctx,
    )
    await target.close(ctx)

    expect(readFileSync(join(baseDir, 'intro.md'), 'utf-8')).toBe('# Custom Intro')
    expect(readFileSync(join(baseDir, 'outro.md'), 'utf-8')).toBe('# Custom Outro')
    expect(() => readFileSync(join(baseDir, 'chapter1.md'), 'utf-8')).toThrow()
  })
})

describe('md target — mdOutputs intents', () => {
  let tempDir: string
  let ctx: TargetContext

  const uri = (path = './chapters'): ParsedUri => ({
    raw: `md://${path}`,
    host: path,
    path,
    query: {},
  })

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'md-intent-'))
    ctx = {
      run: {
        runId: 'run-1',
        global: { project: { name: 'test', root: tempDir }, settings: {} },
      },
    } as unknown as TargetContext
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('resolves a relative root against project.root, not process.cwd()', async () => {
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await target.write(
      {
        item: 'x',
        meta: { mdOutputs: [{ name: 'a', subdir: 'schema', filename: 'a.md', content: 'A' }] },
      },
      ctx,
    )
    await target.close(ctx)

    expect(readFileSync(join(tempDir, 'chapters', 'schema', 'a.md'), 'utf-8')).toBe('A')
  })

  it('treats subdir "" as the target root', async () => {
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await target.write(
      { item: 'x', meta: { mdOutputs: [{ name: 'a', filename: 'a.md', content: 'A' }] } },
      ctx,
    )
    await target.close(ctx)

    expect(readFileSync(join(tempDir, 'chapters', 'a.md'), 'utf-8')).toBe('A')
  })

  it('applies waypoint.md.defaultFolder to the root', async () => {
    ctx = {
      run: {
        runId: 'run-1',
        global: {
          project: { name: 'test', root: tempDir },
          settings: { 'waypoint.md.defaultFolder': 'out' },
        },
      },
    } as unknown as TargetContext

    // defaultFolder only applies to bare directory names (no separator)
    const target = createMdTarget<string>(uri('chapters'))
    await target.open(ctx)
    await target.write(
      {
        item: 'x',
        meta: { mdOutputs: [{ name: 'a', subdir: 'schema', filename: 'a.md', content: 'A' }] },
      },
      ctx,
    )
    await target.close(ctx)

    expect(readFileSync(join(tempDir, 'out', 'chapters', 'schema', 'a.md'), 'utf-8')).toBe('A')
  })

  it('rejects an absolute subdir', async () => {
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write(
        {
          item: 'x',
          meta: {
            mdOutputs: [{ name: 'evil', subdir: '/etc', filename: 'a.md', content: 'A' }],
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/subdir must be relative/)
  })

  it('rejects a subdir that escapes the root', async () => {
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write(
        {
          item: 'x',
          meta: {
            mdOutputs: [{ name: 'evil', subdir: '../escape', filename: 'a.md', content: 'A' }],
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/must not escape/)
  })

  it('rejects a filename containing a separator', async () => {
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write(
        {
          item: 'x',
          meta: {
            mdOutputs: [{ name: 'evil', filename: '../a.md', content: 'A' }],
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/filename must be a basename/)
  })

  it('still accepts the deprecated dir field as a subdir', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await target.write(
      {
        item: 'x',
        meta: { mdOutputs: [{ name: 'legacy', dir: 'legacy', filename: 'a.md', content: 'A' }] },
      },
      ctx,
    )
    await target.close(ctx)
    warn.mockRestore()

    expect(readFileSync(join(tempDir, 'chapters', 'legacy', 'a.md'), 'utf-8')).toBe('A')
  })

  it('warns when two intents in one envelope claim the same path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const target = createMdTarget<string>(uri())
    await target.open(ctx)
    await target.write(
      {
        item: 'x',
        meta: {
          mdOutputs: [
            { name: 'first', subdir: 'dup', filename: 'a.md', content: 'one' },
            { name: 'second', subdir: 'dup', filename: 'a.md', content: 'two' },
          ],
        },
      },
      ctx,
    )
    await target.close(ctx)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'first' and 'second'"))
    warn.mockRestore()
    expect(readFileSync(join(tempDir, 'chapters', 'dup', 'a.md'), 'utf-8')).toBe('two')
  })
})
