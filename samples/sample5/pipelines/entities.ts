import { definePipeline, getVariable } from '@mt/core'
import { type SchemaEntity, createEntitiesTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === entities: named entities of a chapter as `index,name` rows (createEntitiesTool) ===
// Judge: real characters / places / items only, spelled as in the text, nothing missing.
// Compare with `pnpm run ner` (offline heuristic recognizer) on the same chapters.
const llm = pickFor('entities', () => 'index,name\n1,Aldric\n2,Elara')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createEntitiesTool({ model: llm.model, call: llm.schemaCall }))
  .use(
    report({
      tool: 'entities',
      llm,
      render: (env) => ({
        output: (getVariable(env, 'entities') as SchemaEntity[])
          .map((e) => `${e.index}. ${e.name}`)
          .join('\n'),
        info: getVariable(env, 'entitiesLlm'),
      }),
    }),
  )
  .to('md://./out/entities')
