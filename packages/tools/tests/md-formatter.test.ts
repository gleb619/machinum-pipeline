import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { formatMarkdown, formatString, mdFormatter, mdFormatterTool } from '../src/md-formatter.js'

// ---------------------------------------------------------------------------
// mdFormatter tool definition
// ---------------------------------------------------------------------------

describe('mdFormatter', () => {
  it('should have correct name and version', () => {
    expect(mdFormatter.name).toBe('md-formatter')
    expect(mdFormatter.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof mdFormatter.invoke).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// mdFormatterTool factory
// ---------------------------------------------------------------------------

describe('mdFormatterTool', () => {
  it('should create a tool with correct name and version', () => {
    const tool = mdFormatterTool()
    expect(tool.name).toBe('md-formatter')
    expect(tool.version).toBe('1.0.0')
  })

  it('should accept default options', () => {
    const tool = mdFormatterTool({ width: 90, wrapMode: 'preserve' })
    expect(tool.name).toBe('md-formatter')
    expect(tool.version).toBe('1.0.0')
    expect(typeof tool.invoke).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// formatString — real remark pipeline
// ---------------------------------------------------------------------------

describe('formatString', () => {
  it('should format simple markdown', async () => {
    const input = '# Hello\n\nThis is a test.'
    const result = await formatString(input)
    expect(result.formatted).toBeTruthy()
    expect(typeof result.formatted).toBe('string')
    expect(result.formatted.length).toBeGreaterThan(0)
  })

  it('should preserve already-formatted markdown', async () => {
    const input = '# Title\n\nBody text.\n'
    const result = await formatString(input)
    expect(result.formatted).toBe(input)
    expect(result.alreadyFormatted).toBe(true)
  })

  it('should reformat unformatted markdown', async () => {
    const input = '# Title\n\nBody text.'
    const result = await formatString(input)
    expect(result.formatted).not.toBe(input)
    expect(result.alreadyFormatted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('should handle empty string', async () => {
    const result = await formatString('')
    expect(result.formatted).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Tool invoke — real remark pipeline
// ---------------------------------------------------------------------------

describe('mdFormatter tool invoke', () => {
  it('should format envelope item', async () => {
    const result = await mdFormatter.invoke(
      { item: '# Test\n\nContent.', meta: {} },
      {} as ToolContext,
    )
    expect(result.item).toBeTruthy()
    expect(typeof result.item).toBe('string')
    expect(result.meta.mdFormatted).toBe(true)
  })

  it('should set mdAlreadyFormatted true when no change needed', async () => {
    const input = '# Title\n\nBody text.\n'
    const result = await mdFormatter.invoke({ item: input, meta: {} }, {} as ToolContext)
    expect(result.meta.mdAlreadyFormatted).toBe(true)
  })

  it('should set mdAlreadyFormatted false when reformatted', async () => {
    const input = '# Title\n\nBody text.'
    const result = await mdFormatter.invoke({ item: input, meta: {} }, {} as ToolContext)
    expect(result.meta.mdAlreadyFormatted).toBe(false)
  })

  it('should use per-envelope options from meta.mdFormatOptions', async () => {
    const result = await mdFormatter.invoke(
      { item: 'test', meta: { mdFormatOptions: { wrapMode: 'never' } } },
      {} as ToolContext,
    )
    expect(result.item).toBeTruthy()
    expect(result.meta.mdFormatted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stringify options actually reach remark-stringify
// ---------------------------------------------------------------------------

const LONG_PARAGRAPH = `${'word '.repeat(40).trim()}`

describe('stringify options', () => {
  it('should wrap prose at the configured width', async () => {
    const narrow = await formatString(LONG_PARAGRAPH, { width: 80, wrapMode: 'always' })
    const wide = await formatString(LONG_PARAGRAPH, { width: 120, wrapMode: 'always' })

    const narrowLines = narrow.formatted.split('\n').length
    const wideLines = wide.formatted.split('\n').length
    expect(narrowLines).toBeGreaterThan(wideLines)
    for (const line of narrow.formatted.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })

  it('should clamp width into the 80-120 range', async () => {
    const tooSmall = await formatString(LONG_PARAGRAPH, { width: 10, wrapMode: 'always' })
    const tooBig = await formatString(LONG_PARAGRAPH, { width: 1000, wrapMode: 'always' })
    for (const line of tooSmall.formatted.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
    for (const line of tooBig.formatted.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(120)
    }
    expect(tooBig.formatted.split('\n').length).toBeGreaterThan(1)
  })

  it('should not wrap when wrapMode is never', async () => {
    const result = await formatString(LONG_PARAGRAPH, { wrapMode: 'never' })
    expect(result.formatted.trimEnd()).toBe(LONG_PARAGRAPH)
  })

  it('should keep source line breaks by default', async () => {
    const source = 'first line of prose\nsecond line of prose\n\nnext paragraph'
    const result = await formatString(source)
    expect(result.formatted).toContain('first line of prose\nsecond line of prose')
  })

  it('should switch ordered list marker for orderedList one', async () => {
    const input = '1. alpha\n2. beta\n3. gamma'
    const ascending = await formatString(input, { orderedList: 'ascending' })
    const one = await formatString(input, { orderedList: 'one' })

    expect(ascending.formatted).toContain('1. alpha')
    expect(one.formatted).toContain('1) alpha')
  })

  it('should preserve frontmatter through formatting', async () => {
    const input = '---\ntitle: Keep me\n---\n\n# Head\n\nBody.\n'
    const result = await formatString(input)
    expect(result.formatted).toContain('title: Keep me')
    expect(result.formatted).toContain('# Head')
  })
})

// ---------------------------------------------------------------------------
// formatMarkdown over files
// ---------------------------------------------------------------------------

describe('formatMarkdown', () => {
  it('should leave files untouched when write is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fmt-'))
    const path = join(dir, 'a.md')
    const original = 'paragraph with   irregular   spacing'
    await writeFile(path, original, 'utf-8')

    const results = await formatMarkdown(path)

    expect(results).toHaveLength(1)
    expect(results[0]?.alreadyFormatted).toBe(false)
    expect(results[0]?.written).toBe(false)
    expect(await readFile(path, 'utf-8')).toBe(original)
  })

  it('should rewrite changed files when write is true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fmt-'))
    const path = join(dir, 'a.md')
    await writeFile(path, 'paragraph with   irregular   spacing', 'utf-8')

    const results = await formatMarkdown(path, {}, true)

    expect(results[0]?.written).toBe(true)
    expect(await readFile(path, 'utf-8')).toBe(results[0]?.formatted)
  })

  it('should not rewrite already-formatted files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fmt-'))
    const path = join(dir, 'a.md')
    await writeFile(path, '# Title\n\nBody.\n', 'utf-8')

    const results = await formatMarkdown(path, {}, true)

    expect(results[0]?.alreadyFormatted).toBe(true)
    expect(results[0]?.written).toBe(false)
  })

  it('should skip excluded directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fmt-'))
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'keep.md'), '# Keep\n', 'utf-8')
    await writeFile(join(dir, 'node_modules', 'dep.md'), '# Dep\n', 'utf-8')

    const results = await formatMarkdown(dir)

    expect(results).toHaveLength(1)
    expect(results[0]?.path.endsWith('keep.md')).toBe(true)
  })
})
