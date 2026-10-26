import { definePipeline, getVariable } from '@mt/core'
import { createNotesSummaryTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === summary-notes: N short `- ` fact notes per chapter (createNotesSummaryTool) ===
// Judge: every note is one concrete fact from the text, no repeats, nothing invented.
const llm = pickFor('summary-notes', () => '- Mock note one.\n- Mock note two.')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createNotesSummaryTool({ model: llm.model, call: llm.schemaCall, count: 6 }))
  .use(
    report({
      tool: 'summary-notes',
      llm,
      render: (env) => ({
        output: String(getVariable(env, 'summary')),
        info: getVariable(env, 'summaryNotesLlm'),
      }),
    }),
  )
  .to('md://./out/summary-notes')
