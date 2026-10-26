import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { loadBundledPrompt } from '../src/core/bundled-prompts.js'
import type { ChatCompletionInput, ChatCompletionOutput } from '../src/core/openrouter-tool.js'
import {
  applyRelations,
  buildGlossary,
  coOccurrenceRelations,
  createGlossaryExtractor,
  mergeExtractedEntries,
  seedCandidates,
  sortGlossary,
} from '../src/normalization/glossary-extractor.js'
import {
  buildGlossaryGraph,
  findReferences,
  parseGlossaryGraph,
  serializeGlossaryGraph,
} from '../src/normalization/glossary-graph.js'
import { mapCategory, parseGlossaryEntries } from '../src/normalization/glossary-llm.js'
import { createHeuristicNerBackend } from '../src/normalization/ner-candidates.js'
import type { Glossary } from '../src/normalization/term-tagger.js'

const CH1 = [
  '# Chapter 1: Start',
  '',
  'Arin Vale walked into the Iron Keep with Marta. Arin Vale smiled.',
  '',
  '"Take the [Flame Strike]," Marta said. Marta laughed at Arin Vale.',
].join('\n')

const CH2 = [
  '# Chapter 2: Next',
  '',
  'The Iron Keep fell silent. Then Marta nodded. She cast [Flame Strike] again.',
  '',
  'They crossed the Silver River. Later the Silver River froze.',
].join('\n')

const chapters = [
  { chapter: 1, text: CH1 },
  { chapter: 2, text: CH2 },
]

const byTerm = (g: Glossary, term: string) => g.terms.find((t) => t.term === term)
const ctx = {} as ToolContext

/** Scripted LLM backend: records the requests, always answers with `reply`. */
function mockCall(reply: string, seen: ChatCompletionInput[] = []) {
  return async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
    seen.push(input)
    return { content: reply, model: 'mock', tokens: 1, promptTokens: 1, completionTokens: 1 }
  }
}

describe('NER seeding', () => {
  const backend = createHeuristicNerBackend()

  it('finds proper names and locative phrases with their kind', async () => {
    const candidates = await backend.extract([
      { chapter: 1, text: 'Kael walked into the Iron Keep with Mira. Mira waited for Kael.' },
    ])
    const byText = new Map(candidates.map((c) => [c.text, c]))
    expect(byText.get('Iron Keep')?.kind).toBe('place')
    expect(byText.get('Kael')?.kind).toBe('person')
    expect(byText.get('Mira')?.kind).toBe('person')
  })

  it('ignores system messages and common words', async () => {
    const candidates = await backend.extract([
      { chapter: 1, text: '[System: level up!] Then the Chapter ended. The End.' },
    ])
    expect(candidates.map((c) => c.text)).not.toContain('System')
    expect(candidates.map((c) => c.text)).not.toContain('Chapter')
  })

  it('refines a guessed character type and adds the missed candidates', () => {
    const refined = seedCandidates(
      [{ term: 'Iron Keep', count: 1, firstChapter: 1, type: 'character' }],
      [{ text: 'Iron Keep', kind: 'place' }],
    )
    expect(refined[0]?.type).toBe('place')

    const added = seedCandidates([], [{ text: 'Mira', kind: 'person', count: 2, firstChapter: 1 }])
    expect(added).toEqual([{ term: 'Mira', count: 2, firstChapter: 1, type: 'character' }])
  })

  it('seeds the glossary with the entities the frequency heuristics miss', async () => {
    const text = 'Kael entered the Black Keep once. Nobody else did.'
    const glossary = buildGlossary([{ chapter: 1, text }], undefined, {
      ner: await backend.extract([{ chapter: 1, text }]),
    })
    expect(byTerm(glossary, 'Black Keep')?.type).toBe('place')
  })
})

describe('old-term reuse', () => {
  const existing: Glossary = {
    terms: [
      {
        id: 'marta',
        term: 'Marta',
        type: 'character',
        count: 3,
        firstChapter: 1,
        ru: 'Марта',
        aliases: ['Marty'],
      },
    ],
  }

  it('keeps the ru, type and aliases of the terms of the previous glossary', () => {
    const seen: ChatCompletionInput[] = []
    const tool = createGlossaryExtractor({
      load: () => existing,
      call: mockCall(
        JSON.stringify([
          { name: 'Marta', category: 'Location', description: 'A fighter', references: [] },
        ]),
        seen,
      ),
    })
    return tool.invoke({ item: [CH1], items: [CH1], meta: {} }, ctx).then((res) => {
      const glossary = res.meta.glossary as Glossary
      expect(byTerm(glossary, 'Marta')).toMatchObject({
        ru: 'Марта',
        type: 'character',
        aliases: ['Marty'],
      })
      // the reused term is offered to the model as known, never as a candidate
      const user = seen[0]?.messages[0]?.content ?? ''
      expect(user).toContain('Terms already in the glossary')
      expect(user).toContain('Marta')
      const candidates = (user.split('Candidate terms detected')[1] ?? '').split(
        'Text to Analyze',
      )[0]
      expect(candidates).not.toContain('Marta')
    })
  })

  it('adds the terms the model reports and maps their category to a type', () => {
    const glossary = buildGlossary(chapters, existing)
    const merged = mergeExtractedEntries(
      glossary,
      [
        { name: 'Silver River', category: 'Location', description: 'A river', references: [] },
        { name: 'Old Sword', category: 'Object', description: 'A blade', references: [] },
      ],
      new Set(existing.terms.map((t) => t.id)),
    )
    expect(byTerm(merged, 'Silver River')?.type).toBe('place')
    expect(byTerm(merged, 'Old Sword')?.type).toBe('item')
  })

  it('refines the type of a term that is new in this run only', () => {
    const glossary = buildGlossary(chapters, existing)
    const merged = mergeExtractedEntries(
      glossary,
      [{ name: 'Marta', category: 'Location', description: '', references: [] }],
      new Set(existing.terms.map((t) => t.id)),
    )
    expect(byTerm(merged, 'Marta')?.type).toBe('character')
  })

  it('never re-adds an ignored term, not even through the NER seeding or the model', async () => {
    const tool = createGlossaryExtractor({
      load: () => ({ terms: [], ignored: ['Iron Keep'] }),
      call: mockCall(
        JSON.stringify([
          { name: 'Iron Keep', category: 'Location', description: '', references: [] },
        ]),
      ),
    })
    const res = await tool.invoke({ item: [CH1], items: [CH1], meta: {} }, ctx)
    const glossary = res.meta.glossary as Glossary
    expect(byTerm(glossary, 'Iron Keep')).toBeUndefined()
  })

  it('keeps the rejected RU values of the previous glossary', () => {
    const glossary = buildGlossary(chapters, { terms: [], rejected: ['Марта'] })
    expect(glossary.rejected).toEqual(['Марта'])
  })
})

describe('relation graph', () => {
  const graph = buildGlossaryGraph({
    terms: [
      {
        id: 'a',
        term: 'A',
        type: 'character',
        count: 1,
        firstChapter: 1,
        ru: null,
        aliases: [],
        references: ['B'],
      },
      {
        id: 'b',
        term: 'B',
        type: 'place',
        count: 1,
        firstChapter: 1,
        ru: null,
        aliases: [],
        references: ['C'],
      },
      {
        id: 'c',
        term: 'C',
        type: 'item',
        count: 1,
        firstChapter: 1,
        ru: null,
        aliases: [],
      },
    ],
  })

  it('turns the references of the terms into edges', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(graph.edges).toEqual([
      { from: 'a', to: 'b', kind: 'references' },
      { from: 'b', to: 'c', kind: 'references' },
    ])
  })

  it('finds the related terms within 1..3 hops', () => {
    expect(findReferences(graph, 'A', 1)).toEqual(['b'])
    expect(findReferences(graph, 'A', 2)).toEqual(['b', 'c'])
    expect(findReferences(graph, 'A', 3)).toEqual(['b', 'c'])
    expect(findReferences(graph, 'b')).toEqual(['a', 'c'])
    expect(findReferences(graph, 'nope')).toEqual([])
  })

  it('serializes and parses the graph file', () => {
    const json = serializeGlossaryGraph(graph)
    expect(parseGlossaryGraph(json)).toEqual(graph)
    expect(parseGlossaryGraph('not json')).toBeUndefined()
  })

  it('relates the terms that share a sentence of the corpus', () => {
    const glossary = buildGlossary(chapters)
    const related = applyRelations(glossary, coOccurrenceRelations(chapters, glossary))
    expect(byTerm(related, 'Arin Vale')?.references).toContain('Iron Keep')
    expect(byTerm(related, 'Arin Vale')?.references).toContain('Marta')
  })

  it('marks the co-occurrence edges in the graph', () => {
    const glossary = buildGlossary(chapters)
    const co = coOccurrenceRelations(chapters, glossary)
    const graph = buildGlossaryGraph(applyRelations(glossary, co), co)
    const edge = graph.edges.find((e) => e.from === 'arin-vale' && e.to === 'iron-keep')
    expect(edge?.kind).toBe('co-occurrence')
  })

  it('stores the graph in the tool meta', async () => {
    const tool = createGlossaryExtractor()
    const res = await tool.invoke({ item: [CH1, CH2], items: [CH1, CH2], meta: {} }, ctx)
    const glossary = res.meta.glossary as Glossary
    const graphMeta = res.meta.glossaryGraph as { nodes: unknown[]; edges: unknown[] }
    expect(graphMeta.nodes).toHaveLength(glossary.terms.length)
    expect(String(res.meta.glossaryGraphJson)).toContain('"nodes"')
  })
})

describe('LLM stages', () => {
  it('uses the bundled prompts and merges the reported terms', async () => {
    const seen: ChatCompletionInput[] = []
    const tool = createGlossaryExtractor({
      call: mockCall(
        JSON.stringify([
          {
            name: 'Iron Keep',
            category: 'Location',
            description: 'The fortress of the north.',
            references: ['Arin Vale'],
          },
        ]),
        seen,
      ),
    })
    const res = await tool.invoke({ item: [CH1], items: [CH1], meta: {} }, ctx)
    const glossary = res.meta.glossary as Glossary
    expect(seen[0]?.systemPrompt).toBe(loadBundledPrompt('glossary.system'))
    expect(seen[0]?.messages[0]?.content).toContain('Arin Vale walked into the Iron Keep')
    expect(byTerm(glossary, 'Iron Keep')?.type).toBe('place')
    expect(byTerm(glossary, 'Iron Keep')?.description).toBe('The fortress of the north.')
    expect(byTerm(glossary, 'Iron Keep')?.references).toContain('Arin Vale')
  })

  it('falls back to the heuristic glossary when the model reply is unusable', async () => {
    const tool = createGlossaryExtractor({ call: mockCall('not json at all') })
    const res = await tool.invoke({ item: [CH1], items: [CH1], meta: {} }, ctx)
    const glossary = res.meta.glossary as Glossary
    expect(byTerm(glossary, 'Arin Vale')).toBeDefined()
    expect((res.meta.glossaryLlm as { fallbackUsed: boolean }).fallbackUsed).toBe(true)
  })

  it('asks for the relations of the terms without references', async () => {
    const seen: ChatCompletionInput[] = []
    const tool = createGlossaryExtractor({
      call: mockCall(
        JSON.stringify([
          { name: 'Arin Vale', category: 'Character', description: '', references: [] },
        ]),
        seen,
      ),
      relations: { enabled: true, maxTerms: 1 },
      maxAttempts: 1,
    })
    await tool.invoke({ item: [CH1], items: [CH1], meta: {} }, ctx)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[1]?.systemPrompt).toBe(loadBundledPrompt('glossary-relations.system'))
    expect(seen[1]?.messages[0]?.content).toContain('Current Name:')
  })

  it('parses the model answer and maps the categories', () => {
    const entries = parseGlossaryEntries(
      '```json\n[{"name":"Kael","category":"Character","description":"x","references":["Lira"]}]\n```',
    )
    expect(entries).toEqual([
      { name: 'Kael', category: 'Character', description: 'x', references: ['Lira'] },
    ])
    expect(parseGlossaryEntries('{"items":[{"name":"Kael"}]}')[0]?.name).toBe('Kael')
    expect(parseGlossaryEntries('nope')).toEqual([])
    expect(mapCategory('Location')).toBe('place')
    expect(mapCategory('Character')).toBe('character')
    expect(mapCategory('Object')).toBe('item')
    expect(mapCategory('Ability')).toBe('skill')
    expect(mapCategory('Theme')).toBe('term')
  })
})

describe('sortGlossary', () => {
  it('sorts the terms by category then name', () => {
    const sorted = sortGlossary({
      terms: [
        {
          id: 'b',
          term: 'Zeta',
          type: 'character',
          count: 1,
          firstChapter: 1,
          ru: null,
          aliases: [],
        },
        { id: 'a', term: 'Alpha', type: 'place', count: 1, firstChapter: 1, ru: null, aliases: [] },
        {
          id: 'c',
          term: 'Beta',
          type: 'character',
          count: 1,
          firstChapter: 1,
          ru: null,
          aliases: [],
        },
      ],
    })
    expect(sorted.terms.map((t) => t.term)).toEqual(['Beta', 'Zeta', 'Alpha'])
  })
})
