import { definePipeline, getVariable } from '@mt/core'
import { type ProofreadReport, createStatProofread } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'
import { GLOSSARY, mockTranslate, translateChapter } from '../lib/translate.js'

// === proofread: translate (LLM), then measure the result (statProofread, offline) ===
// There is no LLM proofreader: `createStatProofread` checks the RU text with numbers - glossary
// term consistency (EN term left in the text, wrong RU form) and the Cyrillic / Latin letter share.
// Judge: `issues` list real faults; `cyrillicShare` high, `untranslatedShare` low; read the RU
// text for what the counters cannot see (grammar, tone).
const llm = pickFor('translate', mockTranslate('plain'))

export default definePipeline({ id: 'proofread' })
  .from('md://./input/en')
  .use(keepInput)
  .use(translateChapter(llm, 'plain'))
  .use(createStatProofread({ glossary: GLOSSARY }))
  .use(
    report({
      tool: 'proofread',
      llm,
      render: (env) => {
        const proofread = getVariable(env, 'proofread') as ProofreadReport
        return { output: String(env.item), info: proofread }
      },
    }),
  )
  .to('md://./out/proofread')
