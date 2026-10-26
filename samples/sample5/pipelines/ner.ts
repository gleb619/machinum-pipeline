import { definePipeline, getVariable } from '@mt/core'
import { type NerEntity, namedEntityTool } from '@mt/tools'
import '@mt/waypoint'
import { keepInput, report } from '../lib/report.js'

// === ner: OFFLINE named-entity recognizer (heuristic backend, no LLM) ===
// Baseline to compare `pnpm run entities` against: same chapters, no model involved.
// Judge: which names it finds / misses, and the kind (person, place, ...) per entity.
export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(namedEntityTool)
  .use(
    report({
      tool: 'ner',
      llm: { tool: 'offline', model: 'heuristic' },
      render: (env) => ({
        output: (getVariable(env, 'entities') as NerEntity[])
          .map((e) => `${e.text}\t${e.type}`)
          .join('\n'),
      }),
    }),
  )
  .to('md://./out/ner')
