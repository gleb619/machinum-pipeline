import type { Glossary } from '@mt/tools'
import { describe, expect, it } from 'vitest'
import {
  type ChapterEntities,
  type EntitiesArtifact,
  type NerChapter,
  entityKind,
  projectEntities,
  serializeChapterEntities,
  serializeEntities,
} from './entities.js'

const GLOSSARY: Glossary = {
  terms: [
    {
      id: 'arin',
      term: 'Arin',
      type: 'character',
      count: 3,
      firstChapter: 1,
      ru: 'Арин',
      aliases: ['Ar'],
    },
    {
      id: 'marrow',
      term: 'Marrow Bay',
      type: 'place',
      count: 1,
      firstChapter: 1,
      ru: 'Марроу',
      aliases: [],
    },
    {
      id: 'pelargic',
      term: 'Pelargic',
      type: 'term',
      count: 1,
      firstChapter: 2,
      ru: 'Пеларгик',
      aliases: [],
      description: 'A shipping company of the bay.',
    },
    {
      id: 'wreck',
      term: 'Wreck',
      type: 'term',
      count: 1,
      firstChapter: 2,
      ru: 'Обломки',
      aliases: [],
      description: 'The wreck of the Pelargic.',
    },
    {
      id: 'zephyr',
      term: 'Zephyr',
      type: 'character',
      count: 0,
      firstChapter: null,
      ru: 'Зефир',
      aliases: [],
    },
  ],
}

const CHAPTERS: NerChapter[] = [
  { n: 1, text: 'Arin walked to Marrow Bay. Arin rested there.' },
  { n: 2, text: 'Arin met the Pelargic crew. The Wreck stayed.' },
]

describe('entityKind', () => {
  it('maps glossary types to NER kinds without a core type change', () => {
    expect(entityKind('character')).toBe('character')
    expect(entityKind('place')).toBe('place')
    expect(entityKind('item')).toBe('asset')
    expect(entityKind('skill')).toBe('other')
    expect(entityKind('term', 'A shipping company of the bay.')).toBe('organisation')
    expect(entityKind('term', 'The wreck of the Pelargic.')).toBe('other')
  })
})

describe('projectEntities', () => {
  it('projects grounded terms and drops the hallucinated ones', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    expect(projection.dropped).toBe(1)
    expect(projection.entities.map((entity) => entity.name)).toEqual([
      'Arin',
      'Marrow Bay',
      'Pelargic',
      'Wreck',
    ])
    expect(projection.entities.map((entity) => entity.kind)).toEqual([
      'character',
      'place',
      'organisation',
      'other',
    ])
  })

  it('keeps counts, chapters, first chapter, aliases and description', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    const arin = projection.entities.find((entity) => entity.id === 'arin')
    expect(arin).toMatchObject({
      name: 'Arin',
      kind: 'character',
      aliases: ['Ar'],
      firstChapter: 1,
      count: 3,
      chapters: [1, 2],
      description: '',
    })
    const pelargic = projection.entities.find((entity) => entity.id === 'pelargic')
    expect(pelargic?.description).toBe('A shipping company of the bay.')
  })

  it('orders chapters before projecting, so input order does not matter', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    const reversed = projectEntities(GLOSSARY, [...CHAPTERS].reverse())
    expect(reversed).toEqual(projection)
  })

  it('emits one chapter list per chapter, including empty ones', () => {
    const projection = projectEntities(GLOSSARY, [...CHAPTERS, { n: 3, text: 'Nobody came.' }])
    expect(projection.chapters.map((chapter) => chapter.n)).toEqual([1, 2, 3])
    expect(projection.chapters[2]?.entities).toEqual([])
    expect(projection.chapters[0]?.entities).toEqual([
      { id: 'arin', name: 'Arin', kind: 'character', count: 2 },
      { id: 'marrow', name: 'Marrow Bay', kind: 'place', count: 1 },
    ])
  })

  it('sums chapter mentions into the book count', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    for (const entity of projection.entities) {
      const total = projection.chapters.reduce(
        (sum, chapter) =>
          sum + (chapter.entities.find((mention) => mention.id === entity.id)?.count ?? 0),
        0,
      )
      expect(total, entity.name).toBe(entity.count)
    }
  })
})

describe('serializers', () => {
  it('emits the declared entity artefact shape with inline chapters', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    const text = serializeEntities(projection.entities)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('"chapters": [1, 2]')

    const artifact = JSON.parse(text) as EntitiesArtifact
    expect(artifact).toEqual({ version: 1, entities: projection.entities })
  })

  it('serializes a per-chapter file that round-trips', () => {
    const projection = projectEntities(GLOSSARY, CHAPTERS)
    const chapter = projection.chapters[0] as ChapterEntities
    const text = serializeChapterEntities(chapter)
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text) as ChapterEntities).toEqual(chapter)
  })

  it('is deterministic across runs', () => {
    const first = projectEntities(GLOSSARY, CHAPTERS)
    const second = projectEntities(GLOSSARY, CHAPTERS)
    expect(serializeEntities(second.entities)).toBe(serializeEntities(first.entities))
  })
})
