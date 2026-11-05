import { describe, expect, it } from 'vitest'
import {
  chapterBody,
  chapterBodyFromMarkdown,
  chapterTree,
  parseChapterTree,
} from '../src/domain-tree.js'
import type { Chapter } from '../src/domain.js'

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

describe('domain tree', () => {
  it('navigates chapter -> chunk -> paragraph -> line and mutates the line', () => {
    const chapter: Chapter = {
      id: 'ch-1',
      bookId: 'book-1',
      title: 'Title',
      body: 'First line\nsecond line\n\nSecond paragraph\n\n---\n\nNext chunk line',
    }
    const tree = chapterTree(chapter)

    const chunk = requireValue(tree.chunks()[0], 'first chunk')
    const paragraph = requireValue(chunk.paragraphs()[0], 'first paragraph')
    const line = requireValue(paragraph.lines[0], 'first line')
    line.text = 'Changed'

    expect(tree.body).toBe('Changed\nsecond line\n\nSecond paragraph\n\n---\n\nNext chunk line')
    expect(tree.toChapter().body).toBe(tree.body)
    expect(tree.toMarkdown()).toBe(`# Title\n\n${tree.body}`)
  })

  it('derives deterministic hierarchical ids across rebuilds', () => {
    const chapter: Chapter = {
      id: 'ch-2',
      bookId: 'book-1',
      title: 'Ids',
      body: 'hello world',
    }
    const first = chapterTree(chapter)
    const second = chapterTree(chapter)

    const firstLine = requireValue(first.lines()[0], 'first line')
    const secondLine = requireValue(second.lines()[0], 'second line')
    expect(firstLine.id).toBe('ch-2:c0:p0:l0')
    expect(secondLine.id).toBe(firstLine.id)
    expect(firstLine.words()[0]?.id).toBe('ch-2:c0:p0:l0:w0')
  })

  it('handles an empty chapter body', () => {
    const tree = chapterTree({ id: 'empty', bookId: 'book', title: 'Empty', body: '' })
    expect(tree.body).toBe('')
    expect(tree.chunks()).toEqual([])
    expect(tree.paragraphs()).toEqual([])
    expect(tree.lines()).toEqual([])
    expect(tree.words()).toEqual([])
    expect(tree.toMarkdown()).toBe('# Empty\n\n')
  })

  it('normalizes CRLF input and --- separator lines', () => {
    const tree = chapterTree({
      id: 'crlf',
      bookId: 'book',
      title: 'CRLF',
      body: 'one\r\n\r\ntwo\r\n---\r\nthree',
    })

    expect(tree.chunks()).toHaveLength(2)
    expect(tree.body).toBe('one\n\ntwo\n\n---\n\nthree')
    expect(tree.lines().map((line) => line.text)).toEqual(['one', 'two', 'three'])
  })

  it('uses injected chunk and paragraph splitters', () => {
    const tree = chapterTree(
      { id: 'custom', bookId: 'book', title: 'Custom', body: 'ignored' },
      {
        splitChunks: () => ['A|B', 'C'],
        splitParagraphs: (body) => body.split('|'),
      },
    )

    const chunks = tree.chunks()
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.paragraphs().map((paragraph) => paragraph.body)).toEqual(['A', 'B'])
    expect(chunks[1]?.body).toBe('C')
  })

  it('throws for tokens without an injected tokenizer and returns TokenNodes with one', () => {
    const plain = chapterTree({ id: 'tok', bookId: 'book', title: 'Tok', body: 'alpha beta' })
    const chunk = requireValue(plain.chunks()[0], 'chunk')
    expect(() => chunk.tokens()).toThrow('no tokenizer configured')

    const tokenized = chapterTree(
      { id: 'tok', bookId: 'book', title: 'Tok', body: 'alpha beta' },
      { tokenize: (body) => body.split(' ').map((text, tokenId) => ({ tokenId, text })) },
    )
    const tokens = requireValue(tokenized.chunks()[0], 'token chunk').tokens()
    expect(tokens.map((token) => token.text)).toEqual(['alpha', 'beta'])
    expect(tokens[0]?.id).toBe('tok:c0:t0')
  })

  it('supports paragraph line mutation helpers', () => {
    const tree = chapterTree({
      id: 'mut',
      bookId: 'book',
      title: 'Mut',
      body: 'one\ntwo',
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
    expect(paragraph.body).toBe('gamma\nbeta')
    expect(tree.body).toBe('gamma\nbeta')
  })

  it('writes word mutations back into the line and chapter body', () => {
    const tree = chapterTree({
      id: 'words',
      bookId: 'book',
      title: 'Words',
      body: 'hello brave world',
    })
    const line = requireValue(tree.lines()[0], 'line')
    const words = line.words()
    expect(words.map((word) => word.word)).toEqual(['hello', 'brave', 'world'])

    const brave = requireValue(words[1], 'brave word')
    brave.word = 'new'
    expect(line.text).toBe('hello new world')
    expect(tree.body).toBe('hello new world')
  })

  it('parses markdown into a chapter tree', () => {
    const tree = parseChapterTree('# Heading\n\nBody line', { id: 'md', bookId: 'book' })
    expect(tree.title).toBe('Heading')
    expect(tree.body).toBe('Body line')
    expect(tree.toMarkdown()).toBe('# Heading\n\nBody line')
  })

  it('keeps an explicit title and strips the markdown H1 from the body', () => {
    const tree = parseChapterTree('# Other\n\nBody line', {
      id: 'md',
      bookId: 'book',
      title: 'Given',
    })
    expect(tree.title).toBe('Given')
    expect(tree.body).toBe('Body line')
  })

  it('adapts a chapter into the ChapterBody view', () => {
    const body = chapterBody({
      id: 'ch-3',
      bookId: 'book-1',
      title: 'Body',
      body: 'One.\nTwo.\n\nThree.',
    })

    expect(body.text).toBe('One.\nTwo.\n\nThree.')
    expect(body.paragraphs()).toHaveLength(2)
    expect(body.lines().map((line) => line.text)).toEqual(['One.', 'Two.', 'Three.'])
    expect(body.words().map((word) => word.word)).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('adapts markdown into the ChapterBody view', () => {
    const body = chapterBodyFromMarkdown('# Heading\n\nOne.\n\nTwo.', { id: 'md', bookId: 'book' })

    expect(body.text).toBe('One.\n\nTwo.')
    expect(body.lines().map((line) => line.text)).toEqual(['One.', 'Two.'])
  })
})
