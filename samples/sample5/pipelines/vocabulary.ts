import { definePipeline, getVariable } from '@mt/core'
import { createVocabularyTool } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === vocabulary: key terms of a chapter, most important first (createVocabularyTool) ===
// Judge: every word really occurs in the text, the order is by importance, no duplicates.
const llm = pickFor('vocabulary', () => 'word\nsatchel\nparchment\nfallow')

export default definePipeline()
  .from('md://./input/en')
  .use(keepInput)
  .use(createVocabularyTool({ model: llm.model, call: llm.schemaCall }))
  .use(
    report({
      tool: 'vocabulary',
      llm,
      render: (env) => ({
        output: (getVariable(env, 'vocabulary') as string[]).join('\n'),
        info: getVariable(env, 'vocabularyLlm'),
      }),
    }),
  )
  .to('md://./out/vocabulary')
