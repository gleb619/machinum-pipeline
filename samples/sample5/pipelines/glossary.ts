import { definePipeline, getVariable } from '@mt/core'
import { type Glossary, createGlossaryExtractor } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === glossary: terms of the whole corpus (createGlossaryExtractor with the LLM stages on) ===
// Heuristic candidates + NER seed the pool, the model classifies and describes them, related
// terms come from the model + co-occurrence. Both chapters are one batch: the glossary is
// cross-chapter. Without a previous glossary.json every term is new.
// Judge: real names only (no "The", "He"), right `type` (character / place / item / skill),
// useful `description`, sensible `references`. `fallbackUsed: true` = the model answer was rejected.
const llm = pickFor('glossary')

export default definePipeline({ id: 'glossary' })
  .from('md://./input/en')
  .batch(100)
  .use(keepInput)
  .use(
    createGlossaryExtractor({
      call: llm.schemaCall,
      model: llm.model,
      minCount: 2,
      relations: { enabled: true, maxTerms: 4 },
      enrich: { enabled: true, maxTerms: 4 },
    }),
  )
  .use(
    report({
      tool: 'glossary',
      llm,
      filename: 'glossary.md',
      render: (env) => {
        const glossary = getVariable(env, 'glossary') as Glossary
        const rows = glossary.terms.map(
          (t) =>
            `${t.term} | ${t.type} | x${t.count} | ${t.description ?? '-'} | -> ${(t.references ?? []).join(', ') || '-'}`,
        )
        return {
          output: ['term | type | count | description | references', ...rows].join('\n'),
          info: getVariable(env, 'glossaryLlm'),
        }
      },
    }),
  )
  .to('md://./out/glossary')
