import { createExchange, getVariable, registry } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  createSeriesSplitTool,
  createSeriesSplitter,
  readChapterDoc,
  seriesSplitter,
} from '../src/index.js'

const LARGE = [
  '# Chapter One',
  '',
  ...Array.from({ length: 8 }, (_, index) => [
    `Paragraph ${index + 1} line one.`,
    `Paragraph ${index + 1} line two.`,
  ]).flatMap((lines) => [...lines, '']),
].join('\n')

const LARGE_WITH_METADATA = [
  '---',
  'number: 7',
  'series: Existing Saga',
  'warnings:',
  '  - id: 3',
  '    text: Fix this warning',
  '---',
  '',
  LARGE,
].join('\n')

const SMALL = '# Tiny Chapter\n\nOnly one line.\n'
const FORCEABLE = '# Tiny Chapter\n\nline one\nline two\nline three\n'

describe('seriesSplitter', () => {
  it('is registered under the series scheme and its URI/shortcut forms', () => {
    expect(registry.hasSplitter('series')).toBe(true)
    expect(registry.resolveSplitter('series')).toBe(seriesSplitter)
    expect(registry.resolveSplitter('series://')).toBe(seriesSplitter)
    expect(registry.resolveSplitter('series://ladder')).toBe(seriesSplitter)
    expect(registry.resolveSplitter('#series')).toBe(seriesSplitter)
  })

  it('registers every tools splitter after importing @mt/tools', () => {
    expect(registry.resolveSplitter('paragraphs').name).toBe('paragraph-splitter')
    expect(registry.resolveSplitter('lines').name).toBe('line-splitter')
    expect(registry.resolveSplitter('series').name).toBe('series-splitter')
  })

  it('splits a large chapter document into N numbered parts', async () => {
    const splitter = createSeriesSplitter({ parts: 4 })
    const parts = await splitter.split(createExchange(LARGE))
    const docs = parts.map((part) => readChapterDoc(part))

    expect(parts).toHaveLength(4)
    expect(docs.map((doc) => doc.title)).toEqual([
      'Chapter One 1',
      'Chapter One 2',
      'Chapter One 3',
      'Chapter One 4',
    ])
    expect(docs.map((doc) => doc.series)).toEqual([
      'Chapter One',
      'Chapter One',
      'Chapter One',
      'Chapter One',
    ])

    const sourceLines = readChapterDoc(LARGE).body.flatMap((paragraph) => paragraph.lines)
    expect(docs.flatMap((doc) => doc.body.flatMap((paragraph) => paragraph.lines))).toEqual(
      sourceLines,
    )
  })

  it('preserves an existing series name, chapter number and warnings', async () => {
    const splitter = createSeriesSplitter({ parts: 2 })
    const parts = await splitter.split(createExchange(LARGE_WITH_METADATA))
    const docs = parts.map((part) => readChapterDoc(part))

    expect(parts).toHaveLength(2)
    for (const doc of docs) {
      expect(doc.title).toMatch(/^Chapter One [12]$/)
      expect(doc.series).toBe('Existing Saga')
      expect(doc.number).toBe(7)
      expect(doc.warnings).toEqual([{ id: 3, text: 'Fix this warning' }])
    }
  })

  it('returns a small chapter unchanged as one item without series frontmatter', async () => {
    const parts = await seriesSplitter.split(createExchange(SMALL))

    expect(parts).toEqual([SMALL])
    expect(parts[0]).not.toContain('series:')
  })

  it('createSeriesSplitter honors the parts option', async () => {
    const splitter = createSeriesSplitter({ parts: 2 })
    expect(await splitter.split(createExchange(LARGE))).toHaveLength(2)
  })

  it('custom shouldSplit can force a split below the default threshold', async () => {
    const splitter = createSeriesSplitter({ parts: 4, shouldSplit: () => true })
    const parts = await splitter.split(createExchange(FORCEABLE))

    expect(parts).toHaveLength(4)
    expect(parts.map((part) => readChapterDoc(part).title)).toEqual([
      'Tiny Chapter 1',
      'Tiny Chapter 2',
      'Tiny Chapter 3',
      'Tiny Chapter 4',
    ])
    expect(
      parts.every((part) =>
        readChapterDoc(part).body.some((paragraph) => paragraph.lines.length > 0),
      ),
    ).toBe(true)
  })

  it('custom shouldSplit can deny a split of a large chapter', async () => {
    const splitter = createSeriesSplitter({ parts: 2, shouldSplit: () => false })
    expect(await splitter.split(createExchange(LARGE))).toEqual([LARGE])
  })

  it('rejects non-string items with a clear error', async () => {
    await expect(seriesSplitter.split(createExchange(['not', 'text']))).rejects.toThrow(
      'seriesSplitter: item must be a string',
    )
  })
})

describe('seriesSplitTool (backward compatibility)', () => {
  it('reuses splitter parts and sets series/partCount variables', async () => {
    const tool = createSeriesSplitTool({ parts: 2 })
    const output = await tool.invoke(createExchange(LARGE), {} as ToolContext)

    expect(output.item).toHaveLength(2)
    expect(getVariable(output, 'series')).toBe('Chapter One')
    expect(getVariable(output, 'partCount')).toBe(2)
  })

  it('leaves the chapter unchanged and sets no variables when the split condition fails', async () => {
    const tool = createSeriesSplitTool({ parts: 4 })
    const output = await tool.invoke(createExchange(SMALL), {} as ToolContext)

    expect(output.item).toEqual([SMALL])
    expect(getVariable(output, 'series')).toBeUndefined()
    expect(getVariable(output, 'partCount')).toBeUndefined()
  })
})
