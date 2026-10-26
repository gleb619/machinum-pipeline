import { definePipeline, getVariable } from '@mt/core'
import { createSchemaTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === schema: mermaid structure diagram of a chapter (createSchemaTool) ===
// Judge: paste the output into any mermaid viewer; nodes = real events / places, edges in order.
const llm = pickFor('schema', () => 'graph TD\n    Start --> Road\n    Road --> End')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createSchemaTool({ model: llm.model, call: llm.schemaCall }))
  .use(
    report({
      tool: 'schema',
      llm,
      render: (env) => ({
        output: String(getVariable(env, 'schema')),
        info: getVariable(env, 'schemaLlm'),
      }),
    }),
  )
  .to('md://./out/schema')
