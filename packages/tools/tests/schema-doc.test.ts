import { describe, expect, it } from 'vitest'
import {
  type SchemaDocEnvelope,
  type SchemaDocMetadata,
  entitiesTool,
  metadataTool,
  readDoc,
  schemaTool,
  summaryTool,
  vocabularyTool,
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

describe('summaryTool', () => {
  it('returns envelope with meta.summary', async () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await summaryTool.invoke(env, {} as never)

    expect(result.meta.summary).toBe('This is a summary of the test chapter.')
  })
})

describe('entitiesTool', () => {
  it('returns entities from envelope in meta.entities', async () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await entitiesTool.invoke(env, {} as never)

    expect(result.meta.entities).toEqual([
      { index: 1, name: 'Alice' },
      { index: 2, name: 'Bob' },
    ])
  })

  it('returns fallback when no entities section exists', async () => {
    const doc: SchemaDocEnvelope = {
      title: 'No Entities',
      metadata: { chapter: 1, wordCount: 10, tokenCount: 15, charLength: 60 },
      summary: 'No entities here.',
      entities: [],
      vocabulary: [],
    }
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await entitiesTool.invoke(env, {} as never)

    expect(result.meta.entities).toEqual([{ index: 1, name: 'chapter' }])
  })
})

describe('metadataTool', () => {
  it('returns meta.metadata object', async () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await metadataTool.invoke(env, {} as never)

    expect(result.meta.metadata).toEqual({
      chapter: 1,
      wordCount: 500,
      tokenCount: 700,
      charLength: 3200,
    })
  })
})

describe('vocabularyTool', () => {
  it('returns new words excluding knownWords and updates knownWords', async () => {
    const doc: SchemaDocEnvelope = {
      title: 'Vocab Test',
      metadata: { chapter: 1, wordCount: 10, tokenCount: 15, charLength: 60 },
      summary: 'apple banana cherry',
      entities: [],
      vocabulary: [],
    }
    const md = writeDoc(doc)
    const env = { item: md, meta: { knownWords: ['apple'] } }
    const result = await vocabularyTool.invoke(env, {} as never)

    expect(result.meta.vocabulary).toEqual(['banana', 'cherry'])
    expect(result.meta.knownWords).toEqual(['apple', 'banana', 'cherry'])
  })

  it('lowercases words, filters short words, and deduplicates', async () => {
    const doc: SchemaDocEnvelope = {
      title: 'Vocab Test Two',
      metadata: { chapter: 2, wordCount: 10, tokenCount: 15, charLength: 60 },
      summary: 'Apple apple BANANA a b cat!',
      entities: [],
      vocabulary: [],
    }
    const md = writeDoc(doc)
    const env = { item: md, meta: { knownWords: [] } }
    const result = await vocabularyTool.invoke(env, {} as never)

    expect(result.meta.vocabulary).toEqual(['apple', 'banana', 'cat'])
    expect(result.meta.knownWords).toEqual(['apple', 'banana', 'cat'])
  })
})

describe('schemaTool', () => {
  it('returns schema from doc when present', async () => {
    const doc = createFullEnvelope()
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await schemaTool.invoke(env, {} as never)

    expect(result.meta.schema).toBe('graph TD\n    Title --> Next')
  })

  it('generates default mermaid diagram when schema is absent', async () => {
    const doc: SchemaDocEnvelope = {
      title: 'Chapter 5: The Finale',
      metadata: { chapter: 5, wordCount: 10, tokenCount: 15, charLength: 60 },
      summary: 'The end.',
      entities: [],
      vocabulary: [],
    }
    const md = writeDoc(doc)
    const env = { item: md, meta: {} }
    const result = await schemaTool.invoke(env, {} as never)

    expect(typeof result.meta.schema).toBe('string')
    expect(result.meta.schema).toContain('graph TD')
    expect(result.meta.schema).toContain('The Finale')
  })
})
