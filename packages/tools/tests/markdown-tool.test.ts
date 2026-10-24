import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  markdownOutline,
  markdownOutlineTool,
  markdownStats,
  markdownStatsTool,
  markdownStripFrontmatter,
  stripFrontmatter,
} from '../src/normalization/markdown-tool.js'

const SAMPLE = `---
title: Chapter One
---

# Chapter One

Intro paragraph with a [link](https://example.com) and \`code\`.

## Details

- one
- two

\`\`\`ts
const x = 1
\`\`\`

| a | b |
| - | - |
| 1 | 2 |
`

// ---------------------------------------------------------------------------
// markdownStats
// ---------------------------------------------------------------------------

describe('markdownStats', () => {
  it('should count structural nodes', () => {
    const stats = markdownStats(SAMPLE)
    expect(stats.headings).toBe(2)
    expect(stats.title).toBe('Chapter One')
    expect(stats.codeBlocks).toBe(1)
    expect(stats.codeLanguages).toEqual(['ts'])
    expect(stats.links).toBe(1)
    expect(stats.tables).toBe(1)
    expect(stats.listItems).toBe(2)
  })

  it('should detect frontmatter', () => {
    expect(markdownStats(SAMPLE).hasFrontmatter).toBe(true)
    expect(markdownStats('# No frontmatter').hasFrontmatter).toBe(false)
  })

  it('should count words in body only', () => {
    const stats = markdownStats('---\ntitle: Hidden\n---\n\nalpha beta gamma')
    expect(stats.words).toBe(3)
  })

  it('should report character count of raw input', () => {
    expect(markdownStats('abc').characters).toBe(3)
  })

  it('should handle empty input', () => {
    const stats = markdownStats('')
    expect(stats.headings).toBe(0)
    expect(stats.words).toBe(0)
    expect(stats.title).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// markdownOutline
// ---------------------------------------------------------------------------

describe('markdownOutline', () => {
  it('should list headings in document order', () => {
    expect(markdownOutline(SAMPLE)).toEqual([
      { depth: 1, text: 'Chapter One', line: 5 },
      { depth: 2, text: 'Details', line: 9 },
    ])
  })

  it('should return empty outline for plain text', () => {
    expect(markdownOutline('just text')).toEqual([])
  })

  it('should keep inline formatting out of heading text', () => {
    const outline = markdownOutline('## A **bold** title')
    expect(outline[0]?.text).toBe('A bold title')
  })
})

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

describe('stripFrontmatter', () => {
  it('should remove leading frontmatter', () => {
    const { text, stripped } = stripFrontmatter(SAMPLE)
    expect(stripped).toBe(true)
    expect(text.startsWith('---')).toBe(false)
    expect(text).toContain('# Chapter One')
  })

  it('should report not stripped when absent', () => {
    const { text, stripped } = stripFrontmatter('# Plain')
    expect(stripped).toBe(false)
    expect(text).toBe('# Plain')
  })

  it('should not strip thematic breaks in body', () => {
    const input = 'intro\n\n---\n\n# After'
    expect(stripFrontmatter(input).stripped).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tool wrappers
// ---------------------------------------------------------------------------

describe('markdown tools', () => {
  it('should expose correct metadata', () => {
    expect(markdownStatsTool.name).toBe('markdown-stats')
    expect(markdownOutlineTool.name).toBe('markdown-outline')
    expect(markdownStripFrontmatter.name).toBe('markdown-strip-frontmatter')
    for (const tool of [markdownStatsTool, markdownOutlineTool, markdownStripFrontmatter]) {
      expect(tool.version).toBe('1.0.0')
      expect(typeof tool.invoke).toBe('function')
    }
  })

  it('markdownStatsTool should return stats alongside text', async () => {
    const env = await markdownStatsTool.invoke({ item: '# Hi\n\nbody', meta: {} }, {} as never)
    expect(env.item.text).toBe('# Hi\n\nbody')
    expect(env.item.stats.title).toBe('Hi')
    expect(env.meta.markdownStats).toBe(true)
  })

  it('markdownOutlineTool should return outline alongside text', async () => {
    const env = await markdownOutlineTool.invoke({ item: '# Hi', meta: {} }, {} as never)
    expect(env.item.outline).toHaveLength(1)
    expect(env.meta.markdownOutline).toBe(true)
  })

  it('markdownStripFrontmatter should rewrite item text', async () => {
    const env = await markdownStripFrontmatter.invoke({ item: SAMPLE, meta: {} }, {} as never)
    expect(env.item.stripped).toBe(true)
    expect(env.item.text.startsWith('---')).toBe(false)
    expect(env.meta.markdownFrontmatterStripped).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// File-based usage
// ---------------------------------------------------------------------------

describe('markdown tools over files', () => {
  it('should analyze files written to a temp dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-md-'))
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'a.md'), '# A\n\nalpha beta\n', 'utf-8')
    await writeFile(join(dir, 'nested', 'b.md'), '# B\n', 'utf-8')
    await writeFile(join(dir, 'skip.txt'), 'not markdown', 'utf-8')

    const { formatMarkdown } = await import('../src/modification/md-formatter.js')
    const results = await formatMarkdown(dir, { wrapMode: 'never' }, true)

    expect(results).toHaveLength(2)
    expect(results.map((r) => r.path.endsWith('a.md')).some(Boolean)).toBe(true)
    expect(await readFile(join(dir, 'nested', 'b.md'), 'utf-8')).toBe('# B\n')
  })
})
