import { definePipeline, getVariable } from '@mt/core'
import { createMetadataTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === metadata: chapter number + word / token / char counts (createMetadataTool) ===
// Judge: the model must copy the measured numbers it was given; `fallbackUsed: false` means
// it did (the tool rejects wrong numbers). The mock answer is rejected, so the offline run
// shows the deterministic fallback.
const llm = pickFor('metadata')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createMetadataTool({ model: llm.model, call: llm.schemaCall }))
  .use(
    report({
      tool: 'metadata',
      llm,
      render: (env) => ({
        output: JSON.stringify(getVariable(env, 'metadata'), null, 2),
        info: getVariable(env, 'metadataLlm'),
      }),
    }),
  )
  .to('md://./out/metadata')
