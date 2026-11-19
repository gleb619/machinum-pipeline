import { definePipeline } from '@mt/core'
import { createGlossaryExtractor } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../../lib/input.js'
import { pickFor } from '../../lib/llm.js'
import { writeGlossary } from '../../lib/outputs.js'

/**
 * Glossary / term extraction over the whole book.
 *
 * The batch subflow (`batch://?size=100`) hands the child the whole corpus as one package, so
 * counts, `firstChapter` and relations are cross-chapter.
 * The heuristic pass seeds candidates; the picked LLM classifies the names it sees. The
 * resulting `chapters/glossary.json` is meant to be edited by hand (`ru`, `type`, `aliases`,
 * `ignored`) — re-running keeps those edits and only proposes new terms.
 */
const MOCK_GLOSSARY = JSON.stringify([
  {
    name: 'Nadia Okonkwo',
    category: 'character',
    description: 'An audio archivist searching for her missing brother.',
    references: ['Emeka Okonkwo'],
  },
  {
    name: 'Emeka Okonkwo',
    category: 'character',
    description: 'Nadia’s brother, missing since the Pelargic sank.',
    references: ['Nadia Okonkwo'],
  },
  {
    name: 'Marrow Bay',
    category: 'place',
    description: 'The coastal town where the archive sits.',
    references: [],
  },
])

const llm = pickFor('glossary', () => MOCK_GLOSSARY)

const glossaryChild = definePipeline({ id: 'practical-glossary-child' })
  .use(
    createGlossaryExtractor({
      call: llm.schemaCall,
      model: llm.model,
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeGlossary)
  .to('@chapters')

export default definePipeline({ id: 'practical-glossary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', glossaryChild)
