import { describe, expect, it } from 'vitest'
import {
  type SchemaDocEnvelope,
  type SchemaDocMetadata,
  readDoc,
  writeDoc,
} from '../src/schema-doc.js'

function createFullEnvelope(): SchemaDocEnvelope {
  const metadata: SchemaDocMetadata = {
    chapter: 1,
    wordCount: 500,
    tokenCount: 700,
    charLength: 3200,
  }
  return {
    title: 'Test Chapter',
    metadata,
    summary: 'This is a summary of the test chapter.',
    entities: [
      { index: 1, name: 'Alice' },
      { index: 2, name: 'Bob' },
    ],
    vocabulary: ['alpha', 'beta'],
    schema: 'graph TD\n    Title --> Next',
    frontmatter: { author: 'Test Author', draft: true },
  }
}

describe('writeDoc', () => {
  it('produces correct markdown with all sections', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)

    expect(md).toContain('# Test Chapter')
    expect(md).toContain('## Metadata')
    expect(md).toContain('## Summary')
    expect(md).toContain('## Entities')
    expect(md).toContain('## Vocabulary')
    expect(md).toContain('## Schema')
  })

  it('includes metadata table with correct values', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)

    expect(md).toContain('| chapter | wordCount | tokenCount | charLength |')
    expect(md).toContain('| 1 | 500 | 700 | 3200 |')
  })

  it('includes entities CSV code block', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)

    expect(md).toContain('```csv')
    expect(md).toContain('index,name')
    expect(md).toContain('1,Alice')
    expect(md).toContain('2,Bob')
  })

  it('includes vocabulary CSV code block', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)

    expect(md).toContain('```csv')
    expect(md).toContain('word')
    expect(md).toContain('alpha')
    expect(md).toContain('beta')
  })

  it('includes schema mermaid code block', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)

    expect(md).toContain('```mermaid')
    expect(md).toContain('graph TD')
    expect(md).toContain('Title --> Next')
  })

  it('handles optional fields (no schema, no vocabulary, no entities, no frontmatter)', () => {
    const doc: SchemaDocEnvelope = {
      title: 'Minimal Chapter',
      metadata: { chapter: 2, wordCount: 100, tokenCount: 150, charLength: 600 },
      summary: 'A minimal summary.',
      entities: [],
      vocabulary: [],
    }
    const md = writeDoc(doc)

    expect(md).toContain('# Minimal Chapter')
    expect(md).toContain('## Metadata')
    expect(md).toContain('## Summary')
    expect(md).not.toContain('## Entities')
    expect(md).not.toContain('## Vocabulary')
    expect(md).not.toContain('## Schema')
    expect(md).not.toMatch(/^---\n/m)
  })
})

describe('readDoc', () => {
  it('correctly parses a full markdown document', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const parsed = readDoc(md)

    expect(parsed.title).toBe('Test Chapter')
    expect(parsed.summary).toBe('This is a summary of the test chapter.')
    expect(parsed.entities).toEqual([
      { index: 1, name: 'Alice' },
      { index: 2, name: 'Bob' },
    ])
    expect(parsed.vocabulary).toEqual(['alpha', 'beta'])
    expect(parsed.schema).toBe('graph TD\n    Title --> Next')
    expect(parsed.frontmatter).toEqual({ author: 'Test Author', draft: true })
  })

  it('correctly extracts metadata table values as numbers', () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const parsed = readDoc(md)

    expect(parsed.metadata).toEqual({
      chapter: 1,
      wordCount: 500,
      tokenCount: 700,
      charLength: 3200,
    })
    expect(typeof parsed.metadata.chapter).toBe('number')
    expect(typeof parsed.metadata.wordCount).toBe('number')
    expect(typeof parsed.metadata.tokenCount).toBe('number')
    expect(typeof parsed.metadata.charLength).toBe('number')
  })

  it('correctly parses entities CSV', () => {
    const md = `
# Chapter One

## Metadata

| chapter | wordCount | tokenCount | charLength |
|---------|-----------|------------|------------|
| 3 | 200 | 300 | 1200 |

## Summary

A short summary.

## Entities

\`\`\`csv
index,name
10,Charlie
20,Dana
\`\`\`
`
    const parsed = readDoc(md)
    expect(parsed.entities).toEqual([
      { index: 10, name: 'Charlie' },
      { index: 20, name: 'Dana' },
    ])
  })

  it('correctly parses vocabulary CSV', () => {
    const md = `
# Chapter Two

## Metadata

| chapter | wordCount | tokenCount | charLength |
|---------|-----------|------------|------------|
| 4 | 250 | 350 | 1400 |

## Summary

Another summary.

## Vocabulary

\`\`\`csv
word
gamma
delta
epsilon
\`\`\`
`
    const parsed = readDoc(md)
    expect(parsed.vocabulary).toEqual(['gamma', 'delta', 'epsilon'])
  })

  it('correctly extracts schema code block', () => {
    const md = `
# Chapter Three

## Metadata

| chapter | wordCount | tokenCount | charLength |
|---------|-----------|------------|------------|
| 5 | 300 | 400 | 1600 |

## Summary

Summary text.

## Schema

\`\`\`mermaid
graph LR
    A --> B
\`\`\`
`
    const parsed = readDoc(md)
    expect(parsed.schema).toBe('graph LR\n    A --> B')
  })

  it('throws an Error when given invalid markdown', () => {
    expect(() => readDoc('not valid markdown at all')).toThrow()
    expect(() => readDoc('')).toThrow()
    expect(() => readDoc('---\nfoo: bar\n---')).toThrow()
  })

  describe('simple markdown with inner headings', () => {
    it('parses a body containing an inner H1', () => {
      const md = '# Chapter 1: Origin\n\nFirst paragraph.\n\n# The Backstory\n\nSecond paragraph.'
      const parsed = readDoc(md)

      expect(parsed.title).toBe('Chapter 1: Origin')
      expect(parsed.summary).toContain('First paragraph.')
      expect(parsed.summary).toContain('The Backstory')
      expect(parsed.summary).toContain('Second paragraph.')
    })

    it('parses a body containing an inner H2', () => {
      const md = '# Chapter 2: Drift\n\nBefore.\n\n## Aside\n\nAfter.'
      const parsed = readDoc(md)

      expect(parsed.title).toBe('Chapter 2: Drift')
      expect(parsed.summary).toContain('Before.')
      expect(parsed.summary).toContain('Aside')
      expect(parsed.summary).toContain('After.')
    })

    it('parses a body containing an inner H3', () => {
      const md = '# Chapter 3: Deep\n\nTop.\n\n### Deeper\n\nBottom.'
      const parsed = readDoc(md)

      expect(parsed.title).toBe('Chapter 3: Deep')
      expect(parsed.summary).toContain('Top.')
      expect(parsed.summary).toContain('Deeper')
      expect(parsed.summary).toContain('Bottom.')
    })

    it('keeps schema-doc sections after the demoted headings', () => {
      const md = '# Chapter 4: Mixed\n\nBody.\n\n# Inner\n\nMore body.'
      const parsed = readDoc(md)

      expect(parsed.metadata).toEqual({ chapter: 0, wordCount: 0, tokenCount: 0, charLength: 0 })
      expect(parsed.entities).toEqual([])
      expect(parsed.vocabulary).toEqual([])
      expect(parsed.schema).toBeUndefined()
    })
  })
})

describe('write → read → write roundtrip', () => {
  it('preserves all fields and produces identical markdown', () => {
    const original = createFullEnvelope()
    const markdown1 = writeDoc(original)
    const parsed = readDoc(markdown1)

    expect(parsed.title).toBe(original.title)
    expect(parsed.metadata).toEqual(original.metadata)
    expect(parsed.summary).toBe(original.summary)
    expect(parsed.entities).toEqual(original.entities)
    expect(parsed.vocabulary).toEqual(original.vocabulary)
    expect(parsed.schema).toBe(original.schema)
    expect(parsed.frontmatter).toEqual(original.frontmatter)

    const markdown2 = writeDoc(parsed)
    expect(markdown2).toBe(markdown1)
  })
})
