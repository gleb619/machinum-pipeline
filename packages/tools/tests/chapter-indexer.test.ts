import { createExchange } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { chapterIndexer } from '../src/normalization/chapter-indexer.js'

async function indexChapterNum(markdown: string): Promise<unknown> {
  const result = await chapterIndexer.invoke(createExchange(markdown), {} as ToolContext)
  return result.meta?.chapterNum
}

describe('chapterIndexer', () => {
  it('keeps frontmatter number: 0 as 0 (prologue)', async () => {
    const md = '---\nnumber: 0\n---\n\n# Prologue\n\nBody.'
    expect(await indexChapterNum(md)).toBe(0)
  })

  it('reports 0 for an unnumbered doc without a Chapter N heading', async () => {
    const md = '# Prologue\n\nBody.'
    expect(await indexChapterNum(md)).toBe(0)
  })

  it('extracts the number from a "# Chapter 7" heading when frontmatter has none', async () => {
    const md = '# Chapter 7\n\nBody.'
    expect(await indexChapterNum(md)).toBe(7)
  })

  it('uses the frontmatter number when present', async () => {
    const md = '---\nnumber: 5\n---\n\n# Title\n\nBody.'
    expect(await indexChapterNum(md)).toBe(5)
  })

  it('prefers the frontmatter number over a Chapter N heading', async () => {
    const md = '---\nnumber: 3\n---\n\n# Chapter 7\n\nBody.'
    expect(await indexChapterNum(md)).toBe(3)
  })

  it('falls back to a regex match when the h1 has no space after #', async () => {
    const md = '#Chapter 7\n\nBody.'
    expect(await indexChapterNum(md)).toBe(7)
  })
})
