import { definePipeline, defineProcess, defineTool, getVariable, withItem } from '@mt/core'
import {
  type Glossary,
  type LlmRequest,
  type NerEntity,
  type ProofreadReport,
  type SchemaEntity,
  type StatFreqReport,
  createEntitiesTool,
  createGlossaryExtractor,
  createLlmTypoFix,
  createMetadataTool,
  createNotesSummaryTool,
  createSchemaTool,
  createStatDict,
  createStatProofread,
  createStatTranslateDict,
  createSummaryTool,
  createVocabularyTool,
  mockLlmCall,
  namedEntityTool,
  statFreq,
  tokenCounter,
} from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'
import { GLOSSARY, mockTranslate, translateChapter } from '../lib/translate.js'

/**
 * PIPE 09 — the LLM tool gallery, all offline with the mock backend.
 *
 * One tiny pipeline per tool, each writing `chapters/<tool>/<chapter>.md` with the INPUT and
 * the OUTPUT side by side, so the quality of the tool can be judged by eye. Set
 * `MT_LLM_TOOL=ollama` (or `router`) to run the very same pipelines against a real model.
 *
 *   summary / summary-notes    createSummaryTool, createNotesSummaryTool
 *   entities / ner             LLM entity extraction vs. the offline recognizer
 *   vocabulary / metadata      key terms, measured chapter metadata
 *   schema                    mermaid structure diagram
 *   typo-fix                  planted typos, line-count guard
 *   glossary / statdata        cross-chapter glossary / corpus statistics
 *   stat-dict-translate        LLM fills `ru` in the ranked dictionary
 *   proofread                  translate + deterministic RU quality counters
 */
const INPUT = 'md://./fixtures/gallery'

const summaryLlm = pickFor(
  'summary',
  () => 'Mock summary: an archivist follows a tape through a coastal town.',
)
export const summaryPipeline = definePipeline({ id: 'pipe09-summary' })
  .from(INPUT)
  .use(keepInput)
  .use(createSummaryTool({ model: summaryLlm.model, call: summaryLlm.schemaCall }))
  .use(
    report({
      tool: 'summary',
      llm: summaryLlm,
      render: (env) => ({
        output: String(getVariable(env, 'summary')),
        info: getVariable(env, 'summaryLlm'),
      }),
    }),
  )
  .to('md://./chapters/summary')

const notesLlm = pickFor('summary-notes', () => '- Mock note one.\n- Mock note two.')
export const summaryNotesPipeline = definePipeline({ id: 'pipe09-summary-notes' })
  .from(INPUT)
  .use(keepInput)
  .use(createNotesSummaryTool({ model: notesLlm.model, call: notesLlm.schemaCall, count: 6 }))
  .use(
    report({
      tool: 'summary-notes',
      llm: notesLlm,
      render: (env) => ({
        output: String(getVariable(env, 'summary')),
        info: getVariable(env, 'summaryNotesLlm'),
      }),
    }),
  )
  .to('md://./chapters/summary-notes')

const entitiesLlm = pickFor('entities', () => 'index,name\n1,Aldric\n2,Elara')
export const entitiesPipeline = definePipeline({ id: 'pipe09-entities' })
  .from(INPUT)
  .use(keepInput)
  .use(createEntitiesTool({ model: entitiesLlm.model, call: entitiesLlm.schemaCall }))
  .use(
    report({
      tool: 'entities',
      llm: entitiesLlm,
      render: (env) => ({
        output: (getVariable(env, 'entities') as SchemaEntity[])
          .map((entity) => `${entity.index}. ${entity.name}`)
          .join('\n'),
        info: getVariable(env, 'entitiesLlm'),
      }),
    }),
  )
  .to('md://./chapters/entities')

export const nerPipeline = definePipeline({ id: 'pipe09-ner' })
  .from(INPUT)
  .use(keepInput)
  .use(namedEntityTool)
  .use(
    report({
      tool: 'ner',
      llm: { tool: 'offline', model: 'heuristic' },
      render: (env) => ({
        output: (getVariable(env, 'entities') as NerEntity[])
          .map((entity) => `${entity.text}\t${entity.type}`)
          .join('\n'),
      }),
    }),
  )
  .to('md://./chapters/ner')

const vocabularyLlm = pickFor('vocabulary', () => 'word\nsatchel\nparchment\nfallow')
export const vocabularyPipeline = definePipeline({ id: 'pipe09-vocabulary' })
  .from(INPUT)
  .use(keepInput)
  .use(createVocabularyTool({ model: vocabularyLlm.model, call: vocabularyLlm.schemaCall }))
  .use(
    report({
      tool: 'vocabulary',
      llm: vocabularyLlm,
      render: (env) => ({
        output: (getVariable(env, 'vocabulary') as string[]).join('\n'),
        info: getVariable(env, 'vocabularyLlm'),
      }),
    }),
  )
  .to('md://./chapters/vocabulary')

const metadataLlm = pickFor('metadata')
export const metadataPipeline = definePipeline({ id: 'pipe09-metadata' })
  .from(INPUT)
  .use(keepInput)
  .use(tokenCounter)
  .use(createMetadataTool({ model: metadataLlm.model, call: metadataLlm.schemaCall }))
  .use(
    report({
      tool: 'metadata',
      llm: metadataLlm,
      render: (env) => ({
        output: JSON.stringify(getVariable(env, 'metadata'), null, 2),
        info: getVariable(env, 'metadataLlm'),
      }),
    }),
  )
  .to('md://./chapters/metadata')

const schemaLlm = pickFor('schema', () => 'graph TD\n    Start --> Road\n    Road --> End')
export const schemaPipeline = definePipeline({ id: 'pipe09-schema' })
  .from(INPUT)
  .use(keepInput)
  .use(createSchemaTool({ model: schemaLlm.model, call: schemaLlm.schemaCall }))
  .use(
    report({
      tool: 'schema',
      llm: schemaLlm,
      render: (env) => ({
        output: String(getVariable(env, 'schema')),
        info: getVariable(env, 'schemaLlm'),
      }),
    }),
  )
  .to('md://./chapters/schema')

const TYPOS = [
  'tightnd',
  'wieght',
  'accross',
  'befor',
  'diferent',
  'unfamilar',
  'pased',
  'feilds',
  'mutterd',
]
const typoLlm = pickFor('typo-fix', (req: LlmRequest) => req.messages.at(-1)?.content ?? '')
export const typoFixPipeline = definePipeline({ id: 'pipe09-typo-fix' })
  .from('md://./fixtures/typos')
  .use(keepInput)
  .use(createLlmTypoFix({ call: typoLlm.schemaCall }))
  .use(
    report({
      tool: 'typo-fix',
      llm: typoLlm,
      render: (env) => {
        const text = String(env.item)
        const left = TYPOS.filter((typo) => new RegExp(`\\b${typo}\\b`).test(text))
        return {
          output: text,
          info: {
            llmFixed: getVariable(env, 'llmFixed'),
            plantedTypos: TYPOS.length,
            stillInText: left.length,
            left,
          },
        }
      },
    }),
  )
  .to('md://./chapters/typo-fix')

const GLOSSARY_MOCK = JSON.stringify([
  { name: 'Sir Aldric', category: 'character', description: 'A royal messenger.', references: [] },
  { name: 'Elara', category: 'character', description: 'A chestnut mare.', references: [] },
  { name: 'Thornhaven', category: 'place', description: 'A market town.', references: [] },
])
const glossaryLlm = pickFor('glossary', () => GLOSSARY_MOCK)
export const glossaryPipeline = definePipeline({ id: 'pipe09-glossary' })
  .from(INPUT)
  .batch(100)
  .use(keepInput)
  .use(
    createGlossaryExtractor({
      call: glossaryLlm.schemaCall,
      model: glossaryLlm.model,
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(
    report({
      tool: 'glossary',
      llm: glossaryLlm,
      filename: 'glossary.md',
      render: (env) => {
        const glossary = getVariable(env, 'glossary') as Glossary
        const rows = glossary.terms.map(
          (term) =>
            `${term.term} | ${term.type} | x${term.count} | ${term.description ?? '-'} | -> ${(term.references ?? []).join(', ') || '-'}`,
        )
        return {
          output: ['term | type | count | description | references', ...rows].join('\n'),
          info: getVariable(env, 'glossaryLlm'),
        }
      },
    }),
  )
  .to('md://./chapters/glossary')

export const statdataPipeline = definePipeline({ id: 'pipe09-statdata' })
  .from(INPUT)
  .batch(100)
  .use(keepInput)
  .use(statFreq)
  .use(createStatDict({ minCount: 2, topK: 30 }))
  .use(
    report({
      tool: 'statdata',
      llm: { tool: 'offline', model: 'stat' },
      filename: 'statdata.md',
      render: (env) => {
        const freq = getVariable(env, 'statFreq') as StatFreqReport
        const dict = getVariable(env, 'statDict') as Glossary
        const top = freq.top.slice(0, 15).map((term) => `${term.count}\t${term.kind}\t${term.term}`)
        const candidates = dict.terms.map((term) => `${term.type}\t${term.term}\tx${term.count}`)
        return {
          output: [
            `words: ${freq.totalWords} (unique ${freq.uniqueWords})`,
            '',
            'top terms (count, kind, term):',
            ...top,
            '',
            'dictionary candidates (type, term, count):',
            ...candidates,
          ].join('\n'),
        }
      },
    }),
  )
  .to('md://./chapters/statdata')

const dictLlm = pickFor('stat-dict-translate')
const mockDict = mockLlmCall((req) => {
  const text = req.messages.at(-1)?.content ?? ''
  const ids = [...text.matchAll(/"id":\s*"([^"]+)"/g)].map((match) => match[1])
  return JSON.stringify({ translations: ids.map((id) => ({ id, ru: `ру-${id}` })) })
})
const dictGate = createStatTranslateDict({ batchSize: 10 })
const dictAsItem = defineTool<string, Glossary>({
  name: 'pipe09-dict-as-item',
  version: '1.0.0',
  mdDescription: 'Moves meta.statDict into the item.',
  async invoke(env) {
    return withItem(env, getVariable(env, 'statDict') as Glossary)
  },
})

export const statDictTranslatePipeline = definePipeline({ id: 'pipe09-stat-dict-translate' })
  .from(INPUT)
  .batch(100)
  .use(keepInput)
  .use(statFreq)
  .use(createStatDict({ minCount: 3, topK: 10 }))
  .use(dictAsItem)
  .use(dictGate.with({ call: mockDict }))
  .use(
    report({
      tool: 'stat-dict-translate',
      llm: dictLlm,
      filename: 'stat-dict-translate.md',
      render: (env) => {
        const glossary = env.item as Glossary
        return {
          output: glossary.terms
            .map((term) => `${term.term}\t${term.type}\t${term.ru ?? '(empty)'}`)
            .join('\n'),
        }
      },
    }),
  )
  .to('md://./chapters/stat-dict-translate')

const proofLlm = pickFor('proofread', mockTranslate('plain'))
export const proofreadPipeline = definePipeline({ id: 'pipe09-proofread' })
  .from(INPUT)
  .use(keepInput)
  .use(translateChapter(proofLlm, 'plain'))
  .use(createStatProofread({ glossary: GLOSSARY }))
  .use(
    report({
      tool: 'proofread',
      llm: proofLlm,
      render: (env) => ({
        output: String(env.item),
        info: getVariable(env, 'proofread') as ProofreadReport,
      }),
    }),
  )
  .to('md://./chapters/proofread')

export const gallerySuite = defineProcess(
  [
    summaryPipeline,
    summaryNotesPipeline,
    entitiesPipeline,
    nerPipeline,
    vocabularyPipeline,
    metadataPipeline,
    schemaPipeline,
    typoFixPipeline,
    glossaryPipeline,
    statdataPipeline,
    statDictTranslatePipeline,
    proofreadPipeline,
  ],
  { id: 'pipe09-gallery' },
)

export default gallerySuite
