import { definePipeline, getVariable } from '@mt/core'
import type { TranslateWorkMode } from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from './llm.js'
import { keepInput, report } from './report.js'
import { mockTranslate, translateChapter } from './translate.js'

/** The translate pipeline of one work mode (see `translate-<mode>.ts`). */
export function translateFlow(mode: TranslateWorkMode) {
  const llm = pickFor('translate', mockTranslate(mode))
  return definePipeline({ id: `translate-${mode}` })
    .from('md://./input/en')
    .use(keepInput)
    .use(translateChapter(llm, mode))
    .use(
      report({
        tool: `translate-${mode}`,
        llm,
        render: (env) => ({
          output: String(env.item),
          info: { mode: getVariable(env, 'translateMode') },
        }),
      }),
    )
    .to(`md://./out/translate-${mode}`)
}
