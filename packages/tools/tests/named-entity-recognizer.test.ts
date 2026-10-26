import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import {
  createCandidateNerBackend,
  createCompromiseNerBackend,
  createHeuristicEntityBackend,
  createNamedEntityRecognizer,
  createNamedEntityTool,
  createOpenNlpNerBackend,
  heuristicEntityBackend,
  namedEntityTool,
  openNlpModelsFromEnv,
} from '../src/normalization/named-entity-recognizer.js'
import type { NerBackend, NerEntity } from '../src/normalization/named-entity-recognizer.js'

const TEXT = 'Dr. Aris Thorne walked into the Iron Keep with Marta. "Take this," he said.'

const ctx = {} as ToolContext

describe('heuristic entity backend', () => {
  it('finds honorifics, capitalised sequences and quoted names with offsets', async () => {
    const entities = await heuristicEntityBackend.recognize(TEXT)
    const byText = new Map(entities.map((e) => [e.text, e]))

    const aris = byText.get('Aris Thorne')
    expect(aris).toMatchObject({ type: 'person', start: 4, end: 15 })
    expect(TEXT.slice(aris?.start ?? 0, aris?.end ?? 0)).toBe('Aris Thorne')

    const keep = byText.get('Iron Keep')
    expect(keep).toMatchObject({ type: 'place', start: 32, end: 41 })
    expect(TEXT.slice(keep?.start ?? 0, keep?.end ?? 0)).toBe('Iron Keep')

    const marta = byText.get('Marta')
    expect(marta).toMatchObject({ type: 'person' })

    const quoted = byText.get('Take this')
    expect(quoted?.type).toBe('person')
    expect(TEXT.slice(quoted?.start ?? 0, quoted?.end ?? 0)).toBe('Take this')
  })

  it('ignores entities inside [bracketed] system messages', async () => {
    const entities = await heuristicEntityBackend.recognize('[System: Aris Thorne gained a level!]')
    expect(entities.filter((e) => e.text.includes('Aris'))).toHaveLength(0)
  })

  it('needs no env and no model files (default export works standalone)', () => {
    expect(process.env.MT_NER_MODELS).toBeUndefined()
    const recognizer = createNamedEntityRecognizer()
    expect(recognizer.backends.map((b) => b.name)).toEqual(['heuristic'])
  })
})

describe('compromise entity backend', () => {
  it('finds people, places and organizations with correct offsets', async () => {
    const text = 'Maria met Pierre Curie in Paris. She joined OpenAI in New York City.'
    const entities = await createCompromiseNerBackend().recognize(text)
    const byText = new Map(entities.map((e) => [e.text, e]))

    expect(byText.get('Maria')).toMatchObject({ type: 'person', start: 0, end: 5 })
    expect(byText.get('Pierre Curie')).toMatchObject({ type: 'person', start: 10, end: 22 })
    const paris = byText.get('Paris')
    expect(paris).toMatchObject({ type: 'place' })
    expect(text.slice(paris?.start ?? 0, paris?.end ?? 0)).toBe('Paris')
    expect(byText.get('New York City')).toMatchObject({ type: 'place' })
  })
})

describe('opennlp backend', () => {
  it('is disabled (returns null) without MT_NER_MODELS / endpoint', () => {
    expect(createOpenNlpNerBackend()).toBeNull()
  })

  it('parses the MT_NER_MODELS JSON map leniently', () => {
    expect(openNlpModelsFromEnv({})).toEqual({})
    expect(openNlpModelsFromEnv({ MT_NER_MODELS: 'not json' })).toEqual({})
    expect(openNlpModelsFromEnv({ MT_NER_MODELS: '{"person":"/m/en-ner-person.bin"}' })).toEqual({
      person: '/m/en-ner-person.bin',
    })
  })

  it('posts text + models to the endpoint and validates the entity rows', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify({
          entities: [
            { text: 'Aris Thorne', type: 'person', start: 4, end: 15 },
            { text: 'broken' },
            'garbage',
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const backend = createOpenNlpNerBackend({
      models: { person: '/m/en-ner-person.bin' },
      endpoint: 'http://localhost:9999/ner',
      fetchFn,
    })
    expect(backend).not.toBeNull()
    const entities = await backend?.recognize(TEXT)
    expect(entities).toEqual([{ text: 'Aris Thorne', type: 'person', start: 4, end: 15 }])
    expect(seen).toEqual([
      {
        url: 'http://localhost:9999/ner',
        body: { text: TEXT, models: { person: '/m/en-ner-person.bin' } },
      },
    ])
  })

  it('throws on an endpoint error', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const backend = createOpenNlpNerBackend({
      models: { person: '/m/person.bin' },
      endpoint: 'http://localhost:9999/ner',
      fetchFn,
    })
    await expect(backend?.recognize(TEXT)).rejects.toThrow('HTTP 500')
  })
})

describe('createNamedEntityRecognizer (merge/dedupe)', () => {
  const rows = (...list: Array<[string, string]>): NerEntity[] =>
    list.map(([text, type], i) => ({ text, type, start: i * 10, end: i * 10 + text.length }))

  const fakeBackend = (name: string, entities: NerEntity[]): NerBackend => ({
    name,
    recognize: () => entities,
  })

  it('merges all backends, sorted by text (recognizeEntities)', async () => {
    const recognizer = createNamedEntityRecognizer({
      backends: [
        fakeBackend('a', rows(['Marta', 'person'], ['Arin Vale', 'person'])),
        fakeBackend('b', rows(['Iron Keep', 'place'])),
      ],
    })
    const entities = await recognizer.recognizeEntities('x')
    expect(entities.map((e) => e.text)).toEqual(['Arin Vale', 'Iron Keep', 'Marta'])
  })

  it('dedupes by exact text, first occurrence wins (recognizeUniqueEntities)', async () => {
    const recognizer = createNamedEntityRecognizer({
      backends: [
        fakeBackend('a', rows(['Marta', 'person'])),
        fakeBackend('b', rows(['Marta', 'person'])),
        fakeBackend('c', rows(['Iron Keep', 'place'])),
      ],
    })
    const unique = await recognizer.recognizeUniqueEntities('x')
    expect(unique.map((e) => `${e.text}:${e.type}`)).toEqual(['Iron Keep:place', 'Marta:person'])
  })

  it('rejects an empty backend list', () => {
    expect(() => createNamedEntityRecognizer({ backends: [] })).toThrow('at least one backend')
  })
})

describe('namedEntityTool', () => {
  it('stores unique entities in meta.entities, item untouched', async () => {
    const env = await namedEntityTool.invoke({ item: TEXT, meta: {} }, ctx)
    expect(env.item).toBe(TEXT)
    const entities = env.meta.entities as NerEntity[]
    expect(entities.map((e) => e.text)).toEqual(['Aris Thorne', 'Iron Keep', 'Marta', 'Take this'])
  })

  it('merges entities across env.items', async () => {
    const tool = createNamedEntityTool({ backends: [heuristicEntityBackend] })
    const env = await tool.invoke(
      {
        item: 'Arin Vale smiled.',
        items: ['Arin Vale smiled.', 'Marta nodded at the Silver River.'],
        meta: {},
      },
      ctx,
    )
    const entities = env.meta.entities as NerEntity[]
    expect(entities.map((e) => e.text)).toEqual(['Arin Vale', 'Marta', 'Silver River'])
  })
})

describe('createCandidateNerBackend (glossary seeding adapter)', () => {
  it('counts occurrences and tracks the first chapter per entity', async () => {
    const recognizer = createNamedEntityRecognizer({ backends: [createHeuristicEntityBackend()] })
    const backend = createCandidateNerBackend(recognizer)
    const candidates = await backend.extract([
      { chapter: 1, text: 'Marta met Arin Vale. Marta smiled.' },
      { chapter: 3, text: 'Arin Vale left the Iron Keep.' },
    ])
    const byText = new Map(candidates.map((c) => [c.text, c]))
    expect(byText.get('Marta')).toMatchObject({ kind: 'person', count: 2, firstChapter: 1 })
    expect(byText.get('Arin Vale')).toMatchObject({ kind: 'person', count: 2, firstChapter: 1 })
    expect(byText.get('Iron Keep')).toMatchObject({ kind: 'place', count: 1, firstChapter: 3 })
  })
})
