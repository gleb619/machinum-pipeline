import { definePipeline } from '@mt/core'
import { createGlossaryExtractor } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { pickFor } from '../lib/llm.js'
import { MOCK_NER_ANSWER, writeEntities } from '../lib/ner.js'

/**
 * Stage 3 of the book flow: main entities of the whole book (no new `Tool`).
 *
 *   books/book2 chapters → batch://?size=100 → createGlossaryExtractor → writeEntities
 *                                          → chapters/schema/entities.json
 *                                          + chapters/schema/chapter<N>.entities.json
 *
 * One LLM pass over the corpus (`chunkMode:'auto'` is mandatory: the default `shrink` mode
 * truncates at `GLOSSARY_CORPUS_MAX_CHARS = 12_000`, and book2 is ~92 000 chars — 13 % of the
 * book would be seen). Projection back onto chapters is the tagger's `compileTermMatcher` /
 * `countTerms`, so it costs no requests. The batch subflow hands the child the whole corpus as
 * one package: counts, `firstChapter` and the chapter timeline are cross-chapter.
 */
const llm = pickFor('ner', () => MOCK_NER_ANSWER)

const nerChild = definePipeline({ id: 'practical-ner-child' })
  .use(
    createGlossaryExtractor({
      call: llm.schemaCall,
      model: llm.model,
      chunkMode: 'auto',
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeEntities)
  .to('@schema')

export default definePipeline({ id: 'practical-ner' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', nerChild)
