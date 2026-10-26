import { definePipeline, getVariable } from '@mt/core'
import { createLlmTypoFix } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === typo-fix: LLM typo correction of a chapter (createLlmTypoFix) ===
// The input (input/typos/chapter1.md) has these typos planted on purpose, so the result is
// measurable, not only readable: the report counts how many are still in the output.
// Judge: all planted typos gone, nothing else rewritten ([System: ...] line, wording, line count),
// `llmFixed: true` (false = the reply changed the line count and was thrown away).
// The mock backend echoes the text back, so offline every typo is still there.
const PLANTED = [
  'tightnd',
  'wieght',
  'accross',
  'befor',
  'diferent',
  'unfamilar',
  'pased',
  'feilds',
  'mutterd',
]

const llm = pickFor('typo-fix', (req) => req.messages.at(-1)?.content ?? '')

export default definePipeline()
  .from('md://./input/typos')
  .use(keepInput)
  .use(createLlmTypoFix({ call: llm.schemaCall }))
  .use(
    report({
      tool: 'typo-fix',
      llm,
      render: (env) => {
        const text = String(env.item)
        const left = PLANTED.filter((typo) => new RegExp(`\\b${typo}\\b`).test(text))
        return {
          output: text,
          info: {
            llmFixed: getVariable(env, 'llmFixed'),
            plantedTypos: PLANTED.length,
            stillInText: left.length,
            left,
          },
        }
      },
    }),
  )
  .to('md://./out/typo-fix')
