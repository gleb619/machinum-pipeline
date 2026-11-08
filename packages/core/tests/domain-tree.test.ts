import { describe, expect, it } from 'vitest'
import {
  chapterBody,
  chapterBodyFromMarkdown,
  chapterTree,
  parseChapterTree,
} from '../src/domain-tree.js'
import { Chapter } from '../src/types.js'
import type { WordSpan } from '../src/types.js'

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

const meta = { bookId: 'book' }

describe('domain tree', () => {
  it('navigates chapter -> chunk -> paragraph -> line and mutates the line', () => {
    const chapter = new Chapter({
      id: 'ch-1',
      meta: { bookId: 'book-1' },
      text: '# Title\n\nFirst line\nsecond line\n\nSecond paragraph\n\n---\n\nNext chunk line',
    })
    const tree = chapterTree(chapter)

    const chunk = requireValue(tree.chunks()[0], 'first chunk')
    const paragraph = requireValue(chunk.paragraphs()[0], 'first paragraph')
    const line = requireValue(paragraph.lines[0], 'first line')
    line.text = 'Changed'

    expect(tree.content).toBe('Changed\nsecond line\n\nSecond paragraph\n\n---\n\nNext chunk line')
    expect(tree.toChapter().content).toBe(tree.content)
    expect(tree.toMarkdown()).toBe(`# Title\n\n${tree.content}`)
    expect(tree.body().value()).toBe(tree.toMarkdown())
  })

  it('derives deterministic hierarchical ids across rebuilds', () => {
    const chapter = new Chapter({
      id: 'ch-2',
      meta: { bookId: 'book-1' },
      text: '# Ids\n\nhello world',
    })
    const first = chapterTree(chapter)
    const second = chapterTree(chapter)

    const firstLine = requireValue(first.lines()[0], 'first line')
    const secondLine = requireValue(second.lines()[0], 'second line')
    expect(firstLine.id).toBe('ch-2:c0:p0:l0')
    expect(secondLine.id).toBe(firstLine.id)
    expect(firstLine.words()[0]?.id).toBe('ch-2:c0:p0:l0:w0')
  })

  it('handles an empty chapter body', () => {
    const tree = chapterTree({ id: 'empty', meta, text: '# Empty' })
    expect(tree.content).toBe('')
    expect(tree.chunks()).toEqual([])
    expect(tree.paragraphs()).toEqual([])
    expect(tree.lines()).toEqual([])
    expect(tree.words()).toEqual([])
    expect(tree.toMarkdown()).toBe('# Empty')
  })

  it('normalizes CRLF input and --- separator lines', () => {
    const tree = chapterTree({
      id: 'crlf',
      meta,
      text: '# CRLF\n\none\r\n\r\ntwo\r\n---\r\nthree',
    })

    expect(tree.chunks()).toHaveLength(2)
    expect(tree.content).toBe('one\n\ntwo\n\n---\n\nthree')
    expect(tree.lines().map((line) => line.text)).toEqual(['one', 'two', 'three'])
  })

  it('uses injected chunk and paragraph splitters', () => {
    const tree = chapterTree(
      { id: 'custom', meta, text: '# Custom\n\nignored' },
      {
        splitChunks: () => ['A|B', 'C'],
        splitParagraphs: (text) => text.split('|'),
      },
    )

    const chunks = tree.chunks()
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.paragraphs().map((paragraph) => paragraph.text)).toEqual(['A', 'B'])
    expect(chunks[1]?.text).toBe('C')
  })

  it('uses an injected line splitter for the paragraph descent', () => {
    const tree = chapterTree(
      { id: 'line-split', meta, text: '# Lines\n\nignored' },
      {
        splitChunks: () => ['A|B'],
        splitParagraphs: (text) => [text],
        splitLines: (text) => text.split('|'),
      },
    )

    expect(tree.lines().map((line) => line.text)).toEqual(['A', 'B'])
    expect(tree.lines().map((line) => line.id)).toEqual([
      'line-split:c0:p0:l0',
      'line-split:c0:p0:l1',
    ])
  })

  it('uses an injected span-based word splitter for the line descent', () => {
    const splitWords = (text: string): WordSpan[] => {
      const spans: WordSpan[] = []
      let start = 0
      for (const word of text.split(',')) {
        spans.push({ word, start, end: start + word.length })
        start += word.length + 1
      }
      return spans
    }
    const tree = chapterTree({ id: 'word-split', meta, text: '# Words\n\na,b,c' }, { splitWords })
    const line = requireValue(tree.lines()[0], 'line')

    expect(line.words().map((word) => word.text)).toEqual(['a', 'b', 'c'])

    const middle = requireValue(line.words()[1], 'middle word')
    middle.text = 'B'
    expect(line.text).toBe('a,B,c')
    expect(tree.content).toBe('a,B,c')
  })

  it('throws for tokens without an injected tokenizer and returns TokenNodes with one', () => {
    const plain = chapterTree({ id: 'tok', meta, text: '# Tok\n\nalpha beta' })
    const chunk = requireValue(plain.chunks()[0], 'chunk')
    expect(() => chunk.tokens()).toThrow('no tokenizer configured')

    const tokenized = chapterTree(
      { id: 'tok', meta, text: '# Tok\n\nalpha beta' },
      { tokenize: (text) => text.split(' ').map((part, tokenId) => ({ tokenId, text: part })) },
    )
    const tokens = requireValue(tokenized.chunks()[0], 'token chunk').tokens()
    expect(tokens.map((token) => token.text)).toEqual(['alpha', 'beta'])
    expect(tokens[0]?.id).toBe('tok:c0:t0')
  })

  it('supports paragraph line mutation helpers', () => {
    const tree = chapterTree({
      id: 'mut',
      meta,
      text: '# Mut\n\none\ntwo',
    })
    const paragraph = requireValue(tree.paragraphs()[0], 'paragraph')

    paragraph.setText(['alpha', 'beta'])
    expect(paragraph.lines.map((line) => line.text)).toEqual(['alpha', 'beta'])

    paragraph.insertLine(1, 'gamma')
    expect(paragraph.lines.map((line) => line.text)).toEqual(['alpha', 'gamma', 'beta'])
    expect(paragraph.lines.map((line) => line.id)).toEqual([
      'mut:c0:p0:l0',
      'mut:c0:p0:l1',
      'mut:c0:p0:l2',
    ])

    paragraph.removeLine(0)
    expect(paragraph.text).toBe('gamma\nbeta')
    expect(tree.content).toBe('gamma\nbeta')
  })

  it('writes word mutations back into the line and chapter body', () => {
    const tree = chapterTree({
      id: 'words',
      meta,
      text: '# Words\n\nhello brave world',
    })
    const line = requireValue(tree.lines()[0], 'line')
    const words = line.words()
    expect(words.map((word) => word.text)).toEqual(['hello', 'brave', 'world'])

    const brave = requireValue(words[1], 'brave word')
    brave.text = 'new'
    expect(line.text).toBe('hello new world')
    expect(tree.content).toBe('hello new world')
  })

  it('parses markdown into a chapter tree', () => {
    const tree = parseChapterTree('# Heading\n\nBody line', { id: 'md', meta })
    expect(tree.title).toBe('Heading')
    expect(tree.content).toBe('Body line')
    expect(tree.toMarkdown()).toBe('# Heading\n\nBody line')
  })

  it('reads the H1 title from the text', () => {
    const tree = parseChapterTree('# Other\n\nBody line', { id: 'md', meta })
    expect(tree.title).toBe('Other')
    expect(tree.content).toBe('Body line')
  })

  it('adapts a chapter into the ChapterBody view', () => {
    const body = chapterBody({
      id: 'ch-3',
      meta: { bookId: 'book-1' },
      text: '# Body\n\nOne.\nTwo.\n\nThree.',
    })

    expect(body.value()).toBe('# Body\n\nOne.\nTwo.\n\nThree.')
    expect(body.title().value()).toBe('# Body')
    expect(body.content().value()).toBe('One.\nTwo.\n\nThree.')
    expect(body.content().paragraphs()).toHaveLength(2)
    expect(
      body
        .content()
        .lines()
        .map((line) => line.text),
    ).toEqual(['One.', 'Two.', 'Three.'])
    expect(
      body
        .content()
        .words()
        .map((word) => word.text),
    ).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('adapts markdown into the ChapterBody view', () => {
    const body = chapterBodyFromMarkdown('# Heading\n\nOne.\n\nTwo.', { id: 'md', meta })

    expect(body.value()).toBe('# Heading\n\nOne.\n\nTwo.')
    expect(body.title().value()).toBe('# Heading')
    expect(
      body
        .content()
        .lines()
        .map((line) => line.text),
    ).toEqual(['One.', 'Two.'])
  })
})
