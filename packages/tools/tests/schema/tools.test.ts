import type { Envelope } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import { readDoc, schemaDocWriter, writeDoc } from '../../src/modification/schema-doc.js'
import type { SchemaDocEnvelope } from '../../src/modification/schema-doc.js'
import { countWords, metadataGroundTruth, readChapter } from '../../src/normalization/schema/doc.js'
import { entitiesTool } from '../../src/normalization/schema/entities.js'
import { metadataTool } from '../../src/normalization/schema/metadata.js'
import { schemaTool } from '../../src/normalization/schema/schema.js'
import { summaryTool } from '../../src/normalization/schema/summary.js'
import { createSummaryTool } from '../../src/normalization/schema/summary.js'
import { createVocabularyTool, vocabularyTool } from '../../src/normalization/schema/vocabulary.js'
import {
  CHAPTER,
  CHAPTER_TWO,
  ENTITIES_REPLY,
  SCHEMA_REPLY,
  SUMMARY_REPLY,
  VOCABULARY_REPLY,
  installRouter,
  toolContext,
} from './mock-router.js'
import type { MockRouter } from './mock-router.js'

let router: MockRouter | undefined

afterEach(() => {
  router?.restore()
  router = undefined
})

const UNAVAILABLE = () => installRouter([{ status: 503, body: 'no keys left' }])

function envelopeOf(item: string, meta: Record<string, unknown> = {}) {
  return { item, meta }
}

function docWith(overrides: Partial<SchemaDocEnvelope>): SchemaDocEnvelope {
  return {
    title: 'Chapter 1: Test',
    metadata: { chapter: 1, wordCount: 40, tokenCount: 55, charLength: 260 },
    summary: 'Sir Aldric rode to Thornhaven.',
    entities: [],
    vocabulary: [],
    ...overrides,
  }
}

describe('summaryTool (LLM)', () => {
  it('stores the LLM summary in meta.summary and records one attempt', async () => {
    router = installRouter([SUMMARY_REPLY])

    const result = await summaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.item).toBe(CHAPTER)
    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(result.meta.summaryLlm).toMatchObject({ attempts: 1, fallbackUsed: false })
  })

  it('renders the chapter into the prompt', async () => {
    router = installRouter([SUMMARY_REPLY])

    await summaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(router.lastPrompt()).toContain('Chapter 1: The Road from Thornhaven')
    expect(router.lastPrompt()).toContain('harvest festival')
  })

  it('retries with feedback when the answer is rejected, then accepts', async () => {
    router = installRouter(['# Chapter summary\n\nAldric travels.', SUMMARY_REPLY])

    const result = await summaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(result.meta.summaryLlm).toMatchObject({ attempts: 2, fallbackUsed: false })
    expect(router.calls).toHaveLength(2)
    expect(router.lastPrompt()).toContain('rejected (attempt 1 of 3)')
  })

  it('retries when the summary omits the chapter content', async () => {
    router = installRouter(['A man went on a journey somewhere.', SUMMARY_REPLY])

    const result = await summaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(result.meta.summaryLlm).toMatchObject({ attempts: 2 })
  })

  it('falls back to the schema-doc summary when the router is unavailable', async () => {
    router = UNAVAILABLE()

    const result = await summaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.summary).toContain('Sir Aldric rode out of Thornhaven at dawn')
    expect(result.meta.summary).toContain('harvest festival')
    expect(result.meta.summaryLlm).toMatchObject({ attempts: 3, fallbackUsed: true })
    expect(JSON.stringify(result.meta.summaryLlm)).toContain('503')
  })

  it('keeps the whole body when a plain chapter has an inner H1', async () => {
    router = UNAVAILABLE()

    const result = await summaryTool.invoke(
      envelopeOf('# Chapter 1: Origin\n\nFirst paragraph.\n\n# The Backstory'),
      toolContext(),
    )

    expect(result.meta.summary).toContain('First paragraph.')
    expect(result.meta.summary).toContain('The Backstory')
  })

  it('reads the existing Summary section of a schema-doc when the router is unavailable', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(docWith({ summary: 'This is a summary of the test chapter.' }))

    const result = await summaryTool.invoke(envelopeOf(md), toolContext())

    expect(result.meta.summary).toBe('This is a summary of the test chapter.')
  })

  it('accepts a custom prompt and model from the tool options', async () => {
    router = installRouter([SUMMARY_REPLY])
    const tool = createSummaryTool({
      model: 'anthropic/claude-sonnet-4',
      systemPrompt: 'You are a pirate. Summarise for {{title}}.',
      userPrompt: 'Yarr, summarise: {{body}}',
    })

    const result = await tool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(router.calls[0]?.model).toBe('anthropic/claude-sonnet-4')
    expect(router.calls[0]?.messages[0]?.content).toBe(
      'You are a pirate. Summarise for Chapter 1: The Road from Thornhaven.',
    )
    expect(router.lastPrompt()).toContain('Yarr, summarise:')
  })

  it('reads per-envelope prompt and model overrides from meta', async () => {
    router = installRouter([SUMMARY_REPLY])

    await summaryTool.invoke(
      {
        item: CHAPTER,
        meta: { schemaDocLlm: { model: 'meta/model' }, summaryPrompt: 'custom: {{title}}' },
      },
      toolContext(),
    )

    expect(router.calls[0]?.model).toBe('meta/model')
    expect(router.lastPrompt()).toBe('custom: Chapter 1: The Road from Thornhaven')
  })

  it('uses an injected LLM backend instead of the router proxy', async () => {
    router = installRouter(['router answer'])
    const tool = createSummaryTool({
      call: async () => ({
        content: SUMMARY_REPLY,
        model: 'my/model',
        tokens: 30,
        promptTokens: 20,
        completionTokens: 10,
      }),
    })

    const result = await tool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(result.meta.summaryLlm).toMatchObject({
      attempts: 1,
      fallbackUsed: false,
      model: 'my/model',
    })
    expect(router.calls).toHaveLength(0)
  })

  it('processes batched envelopes and keeps per-item summaries', async () => {
    router = installRouter((_call, index) =>
      index === 0 ? SUMMARY_REPLY : 'Aldric is ambushed in the Darkwood by the Duke’s men.',
    )
    const env = { item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: {} }

    const result = await summaryTool.invoke(env, toolContext())

    expect(result.meta.summary).toBe(SUMMARY_REPLY)
    expect(result.meta.summaryByItem).toEqual([
      SUMMARY_REPLY,
      'Aldric is ambushed in the Darkwood by the Duke’s men.',
    ])
    expect(result.meta.summaryLlm).toMatchObject({ attempts: 2, fallbackUsed: false })
  })
})

describe('entitiesTool (LLM)', () => {
  it('parses the LLM CSV into meta.entities', async () => {
    router = installRouter([ENTITIES_REPLY])

    const result = await entitiesTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.entities).toEqual([
      { index: 1, name: 'Sir Aldric' },
      { index: 2, name: 'Thornhaven' },
      { index: 3, name: 'Darkwood' },
      { index: 4, name: 'The Duke' },
    ])
    expect(result.meta.entitiesLlm).toMatchObject({ attempts: 1, fallbackUsed: false })
  })

  it('accepts a bare name list without an index column', async () => {
    router = installRouter(['name\nAldric\nThornhaven'])

    const result = await entitiesTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.entities).toEqual([
      { index: 1, name: 'Aldric' },
      { index: 2, name: 'Thornhaven' },
    ])
  })

  it('retries when the answer invents entities that are not in the chapter', async () => {
    router = installRouter(['index,name\n1,Elon Musk\n2,Mars', ENTITIES_REPLY])

    const result = await entitiesTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.entities).toHaveLength(4)
    expect(result.meta.entitiesLlm).toMatchObject({ attempts: 2 })
    expect(router.lastPrompt()).toContain('none of the entities appear in the chapter')
  })

  it('drops hallucinated rows but keeps the grounded ones', async () => {
    router = installRouter(['index,name\n1,Sir Aldric\n2,Dragonborn'])

    const result = await entitiesTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.entities).toEqual([{ index: 1, name: 'Sir Aldric' }])
  })

  it('falls back to the schema-doc Entities block without a router', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(docWith({ entities: [{ index: 7, name: 'Dana' }] }))

    const result = await entitiesTool.invoke(envelopeOf(md), toolContext())

    expect(result.meta.entities).toEqual([{ index: 7, name: 'Dana' }])
    expect(result.meta.entitiesLlm).toMatchObject({ attempts: 3, fallbackUsed: true })
  })

  it('falls back to the default entity when nothing is available', async () => {
    router = UNAVAILABLE()

    const result = await entitiesTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.entities).toEqual([{ index: 1, name: 'chapter' }])
  })

  it('processes batched envelopes', async () => {
    router = installRouter([ENTITIES_REPLY, 'index,name\n1,Darkwood\n2,Aldric'])
    const env = { item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: {} }

    const result = await entitiesTool.invoke(env, toolContext())

    expect(result.meta.entities).toHaveLength(4)
    expect(result.meta.entitiesByItem).toEqual([
      [
        { index: 1, name: 'Sir Aldric' },
        { index: 2, name: 'Thornhaven' },
        { index: 3, name: 'Darkwood' },
        { index: 4, name: 'The Duke' },
      ],
      [
        { index: 1, name: 'Darkwood' },
        { index: 2, name: 'Aldric' },
      ],
    ])
    expect(result.meta.entitiesLlm).toMatchObject({ attempts: 2 })
  })
})

describe('schemaTool (LLM)', () => {
  it('unwraps the mermaid block into meta.schema', async () => {
    router = installRouter([SCHEMA_REPLY])

    const result = await schemaTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.schema).toBe(
      'graph TD\n    Thornhaven --> Road\n    Road --> Darkwood\n    Aldric --> Tribunal',
    )
    expect(result.meta.schemaLlm).toMatchObject({ attempts: 1, fallbackUsed: false })
  })

  it('retries when the answer is not a diagram', async () => {
    router = installRouter(['This chapter is about a road.', SCHEMA_REPLY])

    const result = await schemaTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(String(result.meta.schema).startsWith('graph TD')).toBe(true)
    expect(result.meta.schemaLlm).toMatchObject({ attempts: 2 })
    expect(router.lastPrompt()).toContain('mermaid type declaration')
  })

  it('retries when the diagram has no edges', async () => {
    router = installRouter(['graph TD\n    Aldric\n    Thornhaven', SCHEMA_REPLY])

    const result = await schemaTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.schemaLlm).toMatchObject({ attempts: 2 })
    expect(router.lastPrompt()).toContain('no edges')
  })

  it('falls back to the schema-doc Schema block without a router', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(docWith({ schema: 'graph LR\n    A --> B' }))

    const result = await schemaTool.invoke(envelopeOf(md), toolContext())

    expect(result.meta.schema).toBe('graph LR\n    A --> B')
  })

  it('generates a default graph from the title when nothing is available', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(
      docWith({ title: 'Chapter 5: The Finale', summary: 'The end.', schema: undefined }),
    )

    const result = await schemaTool.invoke(envelopeOf(md), toolContext())

    expect(result.meta.schema).toBe('graph TD\n    The Finale --> Next')
  })

  it('processes batched envelopes', async () => {
    router = installRouter([SCHEMA_REPLY, 'graph TD\n    Archer --> Aldric'])
    const env = { item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: {} }

    const result = await schemaTool.invoke(env, toolContext())

    expect(result.meta.schema).toContain('Thornhaven --> Road')
    expect(result.meta.schemaByItem).toEqual([
      'graph TD\n    Thornhaven --> Road\n    Road --> Darkwood\n    Aldric --> Tribunal',
      'graph TD\n    Archer --> Aldric',
    ])
  })
})

describe('metadataTool (LLM)', () => {
  const truth = metadataGroundTruth({}, readChapter(CHAPTER), CHAPTER)

  function tableRow(values: {
    chapter: number
    wordCount: number
    tokenCount: number
    charLength: number
  }) {
    return [
      '| chapter | wordCount | tokenCount | charLength |',
      '|---|---|---|---|',
      `| ${values.chapter} | ${values.wordCount} | ${values.tokenCount} | ${values.charLength} |`,
    ].join('\n')
  }

  it('accepts the measured values echoed back as a table', async () => {
    router = installRouter([tableRow(truth)])

    const result = await metadataTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.metadata).toEqual(truth)
    expect(result.meta.metadataLlm).toMatchObject({ attempts: 1, fallbackUsed: false })
  })

  it('feeds the measured values into the prompt', async () => {
    router = installRouter([tableRow(truth)])

    await metadataTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(router.lastPrompt()).toContain(`charLength=${truth.charLength}`)
    expect(router.lastPrompt()).toContain(`wordCount=${truth.wordCount}`)
  })

  it('retries when the model rewrites the counts', async () => {
    router = installRouter([tableRow({ ...truth, wordCount: 999 }), tableRow(truth)])

    const result = await metadataTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.meta.metadata).toEqual(truth)
    expect(result.meta.metadataLlm).toMatchObject({ attempts: 2 })
    expect(router.lastPrompt()).toContain(`wordCount must be ${truth.wordCount}, you wrote 999`)
  })

  it('uses run meta as the ground truth', async () => {
    router = installRouter([
      tableRow({ chapter: 3, wordCount: 12, tokenCount: 99, charLength: 260 }),
    ])

    const result = await metadataTool.invoke(
      { item: CHAPTER, meta: { chapterNum: 3, wordCount: 12, tokenCount: 99, charLength: 260 } },
      toolContext(),
    )

    expect(result.meta.metadata).toEqual({
      chapter: 3,
      wordCount: 12,
      tokenCount: 99,
      charLength: 260,
    })
  })

  it('falls back to the parsed table without a router', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(docWith({}))

    const result = await metadataTool.invoke(envelopeOf(md), toolContext())

    expect(result.meta.metadata).toEqual({
      chapter: 1,
      wordCount: 40,
      tokenCount: 55,
      charLength: 260,
    })
    expect(result.meta.metadataLlm).toMatchObject({ attempts: 3, fallbackUsed: true })
  })

  it('processes batched envelopes', async () => {
    const second = metadataGroundTruth({}, readChapter(CHAPTER_TWO), CHAPTER_TWO)
    router = installRouter([tableRow(truth), tableRow(second)])
    const env = { item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: {} }

    const result = await metadataTool.invoke(env, toolContext())

    expect(result.meta.metadata).toEqual(truth)
    expect(result.meta.metadataByItem).toEqual([truth, second])
  })
})

describe('vocabularyTool (LLM)', () => {
  it('stores new terms and accumulates known words', async () => {
    router = installRouter([VOCABULARY_REPLY])

    const result = await vocabularyTool.invoke(
      { item: CHAPTER, meta: { knownWords: ['aldric'] } },
      toolContext(),
    )

    expect(result.meta.vocabulary).toEqual(['thornhaven', 'darkwood', 'tribunal'])
    expect(result.meta.knownWords).toEqual(['aldric', 'thornhaven', 'darkwood', 'tribunal'])
    expect(result.meta.vocabularyLlm).toMatchObject({ attempts: 1, fallbackUsed: false })
  })

  it('retries when the model invents terms', async () => {
    router = installRouter(['word\ndragon\ncastle\nwizard\nsword', VOCABULARY_REPLY])

    const result = await vocabularyTool.invoke({ item: CHAPTER, meta: {} }, toolContext())

    expect(result.meta.vocabulary).toContain('thornhaven')
    expect(result.meta.vocabularyLlm).toMatchObject({ attempts: 2 })
    expect(router.lastPrompt()).toContain('you invented terms')
  })

  it('caps the term list at the configured limit', async () => {
    router = installRouter([VOCABULARY_REPLY])

    const result = await createVocabularyTool({ limit: 2 }).invoke(
      { item: CHAPTER, meta: {} },
      toolContext(),
    )

    expect(result.meta.vocabulary).toEqual(['aldric', 'thornhaven'])
  })

  it('reads the limit from meta', async () => {
    router = installRouter([VOCABULARY_REPLY])

    const result = await vocabularyTool.invoke(
      { item: CHAPTER, meta: { vocabularyLimit: 1 } },
      toolContext(),
    )

    expect(result.meta.vocabulary).toEqual(['aldric'])
  })

  it('falls back to summary words without a router, deduplicating known words', async () => {
    router = UNAVAILABLE()
    const md = writeDoc(docWith({ summary: 'Apple apple BANANA a b cat!' }))

    const result = await vocabularyTool.invoke(
      { item: md, meta: { knownWords: ['apple'] } },
      toolContext(),
    )

    expect(result.meta.vocabulary).toEqual(['banana', 'cat'])
    expect(result.meta.knownWords).toEqual(['apple', 'banana', 'cat'])
    expect(result.meta.vocabularyLlm).toMatchObject({ attempts: 3, fallbackUsed: true })
  })

  it('processes batched envelopes and carries known words across items', async () => {
    router = installRouter([VOCABULARY_REPLY, 'word\naldric\narcher\nmare'])
    const env = { item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: { knownWords: [] } }

    const result = await vocabularyTool.invoke(env, toolContext())

    expect(result.meta.vocabulary).toEqual(['aldric', 'thornhaven', 'darkwood', 'tribunal'])
    expect(result.meta.vocabularyByItem).toEqual([
      ['aldric', 'thornhaven', 'darkwood', 'tribunal'],
      ['archer', 'mare'],
    ])
    expect(result.meta.knownWords).toContain('archer')
  })
})

describe('schema-doc pipeline shape', () => {
  it('writes a schema-doc from LLM-produced meta sections', async () => {
    router = installRouter([SUMMARY_REPLY, ENTITIES_REPLY, SCHEMA_REPLY])

    let env: Envelope<string> = { item: CHAPTER, meta: { chapterNum: 1 } }
    env = await summaryTool.invoke(env, toolContext())
    env = await entitiesTool.invoke(env, toolContext())
    env = await schemaTool.invoke(env, toolContext())
    const written = await schemaDocWriter.invoke(env, toolContext())

    const md = String(written.item)
    expect(md).toContain('## Summary')
    expect(md).toContain(SUMMARY_REPLY)
    expect(md).toContain('index,name')
    expect(md).toContain('Sir Aldric')
    expect(md).toContain('```mermaid')
    expect(readDoc(md).entities).toHaveLength(4)
    expect(written.meta.mdOutputs).toMatchObject([
      { subdir: 'schema', filename: 'chapter1.schema.md' },
    ])
  })
})

describe('word counting helper', () => {
  it('counts whitespace-separated words for the metadata ground truth', () => {
    expect(countWords('one two  three')).toBe(3)
    expect(countWords('')).toBe(0)
  })
})
