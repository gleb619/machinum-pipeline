import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import {
  type ChapterDoc,
  type ChapterDocParagraph,
  chapterDoc,
  readChapterDoc,
  writeChapterDoc,
} from '../src/chapter-doc.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createFullChapter(): ChapterDoc {
  return {
    title: 'Chapter 1: The Road from Thornhaven',
    number: 1,
    series: 'chapter09.en.md, chapter10.en.md',
    warnings: [
      { id: 1, text: 'Type on line 2, with `HUIJKL` text' },
      { id: 'lang', text: 'Strong language' },
    ],
    body: [
      {
        lines: [
          'Sir Aldric tightened the strap of his battered leather satchel.',
          'The morning sun rose over the hills.',
        ],
      },
      {
        lines: [
          'The road from Thornhaven was long and treacherous.',
          'Bandits lurked in every shadow.',
        ],
      },
    ],
  }
}

function createSimpleChapter(): ChapterDoc {
  return {
    title: 'Simple Chapter',
    number: 2,
    warnings: [],
    body: [{ lines: ['Just a single paragraph with one line.'] }],
  }
}

// ---------------------------------------------------------------------------
// writeChapterDoc
// ---------------------------------------------------------------------------

describe('writeChapterDoc', () => {
  it('produces correct markdown with all frontmatter fields', () => {
    const doc = createFullChapter()
    const md = writeChapterDoc(doc)

    expect(md).toContain('---')
    expect(md).toContain('number: 1')
    expect(md).toContain('series: chapter09.en.md, chapter10.en.md')
    expect(md).toContain('warnings:')
    expect(md).toContain('  - id: 1')
    expect(md).toContain('    text: Type on line 2, with `HUIJKL` text')
    expect(md).toContain('  - id: lang')
    expect(md).toContain('    text: Strong language')
    expect(md).toContain('# Chapter 1: The Road from Thornhaven')

    expect(md).toContain('satchel.  \nThe morning sun')
    expect(md).toContain('treacherous.  \nBandits lurked')
  })

  it('omits series when undefined', () => {
    const doc = createSimpleChapter()
    const md = writeChapterDoc(doc)

    expect(md).not.toContain('series:')
    expect(md).toContain('number: 2')
    expect(md).toContain('# Simple Chapter')
  })

  it('omits warnings array when empty', () => {
    const doc = createSimpleChapter()
    const md = writeChapterDoc(doc)

    expect(md).not.toContain('warnings:')
  })

  it('escapes strings that need quoting in YAML', () => {
    const doc: ChapterDoc = {
      title: 'Quoted',
      number: 3,
      series: 'chapter:one.en.md, chapter:two.en.md',
      warnings: [{ id: 'warn:1', text: 'Has "quotes" and: colons' }],
      body: [{ lines: ['Body text.'] }],
    }
    const md = writeChapterDoc(doc)

    expect(md).toContain('series: "chapter:one.en.md, chapter:two.en.md"')
    expect(md).toContain('id: "warn:1"')
    expect(md).toContain('text: "Has \\"quotes\\" and: colons"')
  })

  it('joins paragraph lines with hard-break markers', () => {
    const doc: ChapterDoc = {
      title: 'Lines Test',
      number: 1,
      warnings: [],
      body: [
        {
          lines: ['Line one', 'Line two', 'Line three'],
        },
      ],
    }
    const md = writeChapterDoc(doc)

    expect(md).toContain('Line one  \nLine two  \nLine three')
  })

  it('separates paragraphs with blank lines', () => {
    const doc = createFullChapter()
    const md = writeChapterDoc(doc)

    const paragraphs = md.split(/\n\n/).filter((b) => b.trim().startsWith('Sir') || b.trim().startsWith('The road'))
    expect(paragraphs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// readChapterDoc
// ---------------------------------------------------------------------------

describe('readChapterDoc', () => {
  it('correctly parses a full markdown document', () => {
    const doc = createFullChapter()
    const md = writeChapterDoc(doc)
    const parsed = readChapterDoc(md)

    expect(parsed.title).toBe(doc.title)
    expect(parsed.number).toBe(doc.number)
    expect(parsed.series).toBe(doc.series)
    expect(parsed.warnings).toEqual(doc.warnings)
    expect(parsed.body).toEqual(doc.body)
  })

  it('correctly parses markdown without optional fields', () => {
    const md = '# Simple Title\n\nFirst paragraph.\n\nSecond paragraph.'
    const parsed = readChapterDoc(md)

    expect(parsed.title).toBe('Simple Title')
    expect(parsed.number).toBe(1)
    expect(parsed.series).toBeUndefined()
    expect(parsed.warnings).toEqual([])
    expect(parsed.body).toEqual([
      { lines: ['First paragraph.'] },
      { lines: ['Second paragraph.'] },
    ])
  })

  it('reads warnings from frontmatter', () => {
    const md = `---\nnumber: 5\nwarnings:\n  - id: x\n    text: y\n---\n\n# Title\n\nBody.`
    const parsed = readChapterDoc(md)

    expect(parsed.number).toBe(5)
    expect(parsed.warnings).toEqual([{ id: 'x', text: 'y' }])
  })

  it('preserves lines within paragraphs when hard breaks present', () => {
    const md = '# Poetry\n\nRoses are red  \nViolets are blue\n\nSugar is sweet  \nAnd so are you'
    const parsed = readChapterDoc(md)

    expect(parsed.body).toEqual([
      { lines: ['Roses are red', 'Violets are blue'] },
      { lines: ['Sugar is sweet', 'And so are you'] },
    ])
  })

  it('handles paragraphs without hard breaks', () => {
    const md = '# Title\n\nThis is one long paragraph that spans multiple words without any hard line breaks.\n\nSecond paragraph here.'
    const parsed = readChapterDoc(md)

    expect(parsed.body).toHaveLength(2)
    expect(parsed.body[0].lines).toEqual([
      'This is one long paragraph that spans multiple words without any hard line breaks.',
    ])
    expect(parsed.body[1].lines).toEqual(['Second paragraph here.'])
  })

  it('throws on missing h1', () => {
    expect(() => readChapterDoc('no heading here')).toThrow('no h1 title found')
    expect(() => readChapterDoc('')).toThrow('no h1 title found')
  })
})

// ---------------------------------------------------------------------------
// Roundtrip
// ---------------------------------------------------------------------------

describe('write → read → write → read roundtrip', () => {
  it('preserves all fields through four stages', () => {
    const original = createFullChapter()

    const md1 = writeChapterDoc(original)
    const parsed1 = readChapterDoc(md1)
    const md2 = writeChapterDoc(parsed1)
    const parsed2 = readChapterDoc(md2)

    expect(parsed2).toEqual(original)
    expect(md2).toBe(md1)
  })

  it('roundtrips a simple chapter', () => {
    const original = createSimpleChapter()

    const md1 = writeChapterDoc(original)
    const parsed1 = readChapterDoc(md1)
    const md2 = writeChapterDoc(parsed1)
    const parsed2 = readChapterDoc(md2)

    expect(parsed2).toEqual(original)
    expect(md2).toBe(md1)
  })

  it('roundtrips with special characters in strings', () => {
    const original: ChapterDoc = {
      title: 'Chapter: "The End"',
      number: 99,
      series: 'chapter:final.en.md',
      warnings: [{ id: 'warn:1', text: 'Text with "quotes"' }],
      body: [{ lines: ['Line with: colon and "quotes".'] }],
    }

    const md1 = writeChapterDoc(original)
    const parsed1 = readChapterDoc(md1)
    const md2 = writeChapterDoc(parsed1)
    const parsed2 = readChapterDoc(md2)

    expect(parsed2).toEqual(original)
    expect(md2).toBe(md1)
  })
})

// ---------------------------------------------------------------------------
// md-formatter compatibility
// ---------------------------------------------------------------------------

function simulateFormatterPreserve(md: string): string {
  return md
}

function simulateFormatterAlways(md: string): string {
  return md.replace(/  \n/g, ' ')
}

function simulateFormatterRewrapAt80(md: string): string {
  let result = md.replace(/  \n/g, ' ')
  const lines = result.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) {
      out.push(line)
      continue
    }
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('number:') || line.startsWith('series:') || line.startsWith('warnings:') || line.startsWith('  -')) {
      out.push(line)
      continue
    }
    let remaining = line
    while (remaining.length > 80) {
      const wrapAt = remaining.lastIndexOf(' ', 80)
      const splitAt = wrapAt > 0 ? wrapAt : 80
      out.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    if (remaining.length > 0) out.push(remaining)
  }
  return out.join('\n')
}

describe('md-formatter compatibility', () => {
  it('read survives wrapMode: preserve (no changes)', () => {
    const original = createFullChapter()
    const md = writeChapterDoc(original)
    const formatted = simulateFormatterPreserve(md)
    const parsed = readChapterDoc(formatted)

    expect(parsed.title).toBe(original.title)
    expect(parsed.number).toBe(original.number)
    expect(parsed.series).toBe(original.series)
    expect(parsed.warnings).toEqual(original.warnings)
    expect(parsed.body).toEqual(original.body)
  })

  it('read survives removal of hard breaks', () => {
    const original = createFullChapter()
    const md = writeChapterDoc(original)
    const formatted = simulateFormatterAlways(md)
    const parsed = readChapterDoc(formatted)

    expect(parsed.title).toBe(original.title)
    expect(parsed.number).toBe(original.number)
    expect(parsed.series).toBe(original.series)
    expect(parsed.warnings).toEqual(original.warnings)

    expect(parsed.body).toHaveLength(original.body.length)

    const originalText = original.body.map((p) => p.lines.join(' ')).join(' ')
    const parsedText = parsed.body.map((p) => p.lines.join(' ')).join(' ')
    expect(parsedText).toBe(originalText)
  })

  it('read survives aggressive rewrapping at 80 chars', () => {
    const original = createFullChapter()
    const md = writeChapterDoc(original)
    const formatted = simulateFormatterRewrapAt80(md)
    const parsed = readChapterDoc(formatted)

    expect(parsed.title).toBe(original.title)
    expect(parsed.number).toBe(original.number)
    expect(parsed.warnings).toEqual(original.warnings)

    expect(parsed.body).toHaveLength(original.body.length)

    const originalText = original.body.map((p) => p.lines.join(' ')).join(' ')
    const parsedText = parsed.body.map((p) => p.lines.join(' ')).join(' ')
    expect(parsedText).toBe(originalText)
  })

  it('read survives formatter on chapter with many warnings', () => {
    const original: ChapterDoc = {
      title: 'Heavily Tagged',
      number: 7,
      series: 'chapter08.en.md, chapter09.en.md',
      warnings: [
        { id: 'gore', text: 'Graphic descriptions of wounds' },
        { id: 'spoilers', text: 'Major plot spoilers for Book 2' },
        { id: 'lang', text: 'Frequent profanity' },
      ],
      body: [
        { lines: ['First line of first paragraph.', 'Second line of first paragraph.'] },
        { lines: ['Only line of second paragraph.'] },
        { lines: ['Third paragraph line one.', 'Third paragraph line two.', 'Third paragraph line three.'] },
      ],
    }

    const md = writeChapterDoc(original)
    const formatted = simulateFormatterRewrapAt80(md)
    const parsed = readChapterDoc(formatted)

    expect(parsed.title).toBe(original.title)
    expect(parsed.number).toBe(original.number)
    expect(parsed.series).toBe(original.series)
    expect(parsed.warnings).toEqual(original.warnings)
    expect(parsed.body).toHaveLength(original.body.length)

    const originalText = original.body.map((p) => p.lines.join(' ')).join(' ')
    const parsedText = parsed.body.map((p) => p.lines.join(' ')).join(' ')
    expect(parsedText).toBe(originalText)
  })
})

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

describe('chapterDoc tool', () => {
  it('wraps writeChapterDoc and sets meta.mdOutputs when chapterNum present', async () => {
    const env = {
      item: { title: 'Test Chapter', body: 'Hello world.' },
      meta: { chapterNum: 2 },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)

    expect(result.item).toContain('# Test Chapter')
    expect(result.item).toContain('Hello world.')
    expect(result.item).toContain('number: 2')

    const mdOutputs = result.meta.mdOutputs as Array<{
      name: string
      dir: string
      filename: string
      content: string
    }>
    expect(mdOutputs).toEqual([
      {
        name: 'chapter',
        dir: 'chapters/en',
        filename: 'chapter2.md',
        content: result.item,
      },
    ])
    expect((result.meta.chapterDoc as ChapterDoc).title).toBe('Test Chapter')
  })

  it('accepts structured body as Paragraph[]', async () => {
    const body: ChapterDocParagraph[] = [
      { lines: ['Line one', 'Line two'] },
      { lines: ['Para two'] },
    ]
    const env = {
      item: { title: 'Structured', body, number: 5 },
      meta: { chapterNum: 5 },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.item).toContain('Line one  \nLine two')
    expect(result.item).toContain('Para two')
    expect(result.item).toContain('number: 5')
  })

  it('reads number from item when meta.chapterNum is absent', async () => {
    const env = {
      item: { title: 'Test', body: 'Body.', number: 9 },
      meta: {},
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.item).toContain('number: 9')
    expect(result.meta.mdOutputs).toBeUndefined()
  })

  it('defaults number to 1 when no source available', async () => {
    const env = {
      item: { title: 'Test', body: 'Body.' },
      meta: {},
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.item).toContain('number: 1')
  })

  it('reads warnings from meta.warnings', async () => {
    const env = {
      item: { title: 'Warned', body: 'Body.' },
      meta: {
        chapterNum: 1,
        warnings: [
          { id: 'w1', text: 'Warning one' },
          { id: 'w2', text: 'Warning two' },
        ],
      },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.item).toContain('warnings:')
    expect(result.item).toContain('id: w1')
    expect(result.item).toContain('text: Warning one')
  })

  it('reads series from meta.chapterSeries', async () => {
    const env = {
      item: { title: 'Series', body: 'Body.' },
      meta: { chapterNum: 1, chapterSeries: 'chapter09.en.md, chapter10.en.md' },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.item).toContain('series: chapter09.en.md, chapter10.en.md')
  })

  it('does not set mdOutputs when chapterNum is missing', async () => {
    const env = {
      item: { title: 'Test', body: 'Body.' },
      meta: {},
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    expect(result.meta.mdOutputs).toBeUndefined()
  })

  it('appends to existing mdOutputs without overwriting', async () => {
    const env = {
      item: { title: 'Test', body: 'Body.' },
      meta: {
        chapterNum: 3,
        mdOutputs: [{ name: 'existing', dir: 'tmp', filename: 'x.md', content: 'x' }],
      },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)

    const mdOutputs = result.meta.mdOutputs as Array<{
      name: string
      dir: string
      filename: string
      content: string
    }>
    expect(mdOutputs).toHaveLength(2)
    expect(mdOutputs[0]).toEqual({
      name: 'existing',
      dir: 'tmp',
      filename: 'x.md',
      content: 'x',
    })
    expect(mdOutputs[1]).toEqual({
      name: 'chapter',
      dir: 'chapters/en',
      filename: 'chapter3.md',
      content: result.item,
    })
  })

  it('splits string body by blank lines into paragraphs', async () => {
    const env = {
      item: {
        title: 'String Body',
        body: 'Paragraph one line one.\n\nParagraph two line one.\nParagraph two line two.\n\nParagraph three.',
      },
      meta: { chapterNum: 1 },
    }

    const result = await chapterDoc.invoke(env, {} as ToolContext)
    const doc = result.meta.chapterDoc as ChapterDoc

    expect(doc.body).toHaveLength(3)
    expect(doc.body[0].lines).toEqual(['Paragraph one line one.'])
    expect(doc.body[1].lines).toEqual(['Paragraph two line one. Paragraph two line two.'])
    expect(doc.body[2].lines).toEqual(['Paragraph three.'])
  })
})
