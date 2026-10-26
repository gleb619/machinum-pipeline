import { definePipeline, getVariable } from '@mt/core'
import { createSummaryTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === summary: one flowing paragraph per chapter (createSummaryTool) ===
// Judge: facts match the chapter, 3-6 sentences, no invented events. `fallbackUsed: true` in
// the report means the model answer was rejected 3 times and the raw text was used instead.
const llm = pickFor('summary', () => 'Mock summary: a knight rides out and meets strangers.')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createSummaryTool({ model: llm.model, call: llm.schemaCall }))
  .use(
    report({
      tool: 'summary',
      llm,
      render: (env) => ({
        output: String(getVariable(env, 'summary')),
        info: getVariable(env, 'summaryLlm'),
      }),
    }),
  )
  .to('md://./out/summary')
