import { createExchange, getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  VAR_BOOK,
  bookCompiler,
  bookCompilerBuild,
  bookCompilerEmit,
  bookCompilerValidate,
} from './book-compiler.js'
import type { BookDoc } from './book-compiler.js'
import type { ChapterDoc } from './chapter-doc.js'

const ctx = {} as ToolContext

function makeChapter(number: number, title: string, bodyText = 'Some paragraph.'): ChapterDoc {
  return {
    number,
    warnings: [],
    chapter: {
      id: `chapter-${number}`,
      bookId: 'book',
      title,
      body: bodyText,
    },
  }
}

function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('# '))
}

describe('book-compiler', () => {
  it('builds a TOC from 3 chapters with matching anchors', async () => {
    const chapters = [
      makeChapter(1, 'Chapter One', 'First paragraph.'),
      makeChapter(2, 'Chapter Two', 'Second paragraph.'),
      makeChapter(3, 'Chapter Three', 'Third paragraph.'),
    ]

    const result = await bookCompiler.invoke(createExchange({ title: 'Test Book', chapters }), ctx)

    const markdown = result.item
    expect(markdown).toContain('title: "Test Book"')
    expect(markdown).toContain('chapterCount: 3')
    expect(markdown).toContain('## Table of Contents')
    expect(markdown).toContain('- [Chapter One](#chapter-one)')
    expect(markdown).toContain('- [Chapter Two](#chapter-two)')
    expect(markdown).toContain('- [Chapter Three](#chapter-three)')
    expect(headings(markdown)).toEqual(['# Chapter One', '# Chapter Two', '# Chapter Three'])
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('accepts a bare list of chapters', async () => {
    const chapters = [
      makeChapter(1, 'Chapter One', 'First paragraph.'),
      makeChapter(2, 'Chapter Two', 'Second paragraph.'),
    ]

    const result = await bookCompiler.invoke(createExchange(chapters), ctx)

    expect(headings(result.item)).toEqual(['# Chapter One', '# Chapter Two'])
  })

  it('reports gaps, duplicate numbers, out-of-order chapters, duplicate titles and duplicate paragraphs', async () => {
    const chapters = [
      makeChapter(1, 'Alpha', 'Shared paragraph.'),
      makeChapter(2, 'Beta', 'Unique beta text.'),
      makeChapter(2, 'Beta', 'Unique beta text.'),
      makeChapter(5, 'Delta', 'Shared paragraph.'),
      makeChapter(3, 'Gamma', 'Unique gamma text.'),
    ]

    const result = await bookCompiler.invoke(createExchange({ title: 'T', chapters }), ctx)
    const doc = getVariable<BookDoc>(result, VAR_BOOK)

    const codes = doc?.warnings.map((warning) => warning.code) ?? []
    expect(codes).toContain('DUPLICATE_NUMBER')
    expect(codes).toContain('GAP')
    expect(codes).toContain('OUT_OF_ORDER')
    expect(codes).toContain('DUPLICATE_TITLE')
    expect(codes).toContain('DUPLICATE_PARAGRAPH')

    const gap = doc?.warnings.find((warning) => warning.code === 'GAP')
    expect(gap?.chapterNumber).toBe(4)
    const duplicate = doc?.warnings.find((warning) => warning.code === 'DUPLICATE_NUMBER')
    expect(duplicate?.chapterNumber).toBe(2)
  })

  it('reports an empty chapter body', async () => {
    const chapters = [
      makeChapter(1, 'Alpha', 'Text.'),
      {
        ...makeChapter(2, 'Beta'),
        chapter: { ...makeChapter(2, 'Beta').chapter, body: '' },
      },
    ]

    const built = await bookCompilerBuild.invoke(createExchange({ chapters }), ctx)
    const validated = await bookCompilerValidate.invoke(built, ctx)

    const codes = validated.item.warnings.map((warning) => warning.code)
    expect(codes).toContain('EMPTY_BODY')
    const empty = validated.item.warnings.find((warning) => warning.code === 'EMPTY_BODY')
    expect(empty?.chapterNumber).toBe(2)
  })

  it('uses a domain chapter index as its chapter number', async () => {
    const chapters = [
      { id: 'c2', bookId: 'b', title: 'Prologue', body: 'Text.', index: 2 },
      { id: 'c3', bookId: 'b', title: 'Epilogue', body: 'More text.', index: 3 },
    ]

    const built = await bookCompilerBuild.invoke(createExchange(chapters), ctx)

    expect(built.item.chapters.map((chapter) => chapter.number)).toEqual([2, 3])
  })

  it('emits markdown only — the target does the writing', async () => {
    const doc: BookDoc = {
      title: 'My Book',
      chapters: [makeChapter(1, 'Chapter One', 'First paragraph.')],
      toc: [{ number: 1, title: 'Chapter One', anchor: 'chapter-one' }],
      warnings: [],
    }

    const result = await bookCompilerEmit.invoke(createExchange(doc), ctx)

    expect(result.item).toContain('# Chapter One')
    expect(result.item).toContain('---')
    expect(result.item).toContain('## Table of Contents')
    expect(result.item.endsWith('\n')).toBe(true)
  })
})
