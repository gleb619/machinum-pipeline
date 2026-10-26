import { definePipeline, defineTool, withItem } from '@mt/core'
import {
  type LlmRequest,
  type TitleTranslatorInput,
  type TitleTranslatorOutput,
  createTitleTranslator,
} from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === translate-title: the generic title translator (createTitleTranslator) ===
// Reads the `# ` heading of each chapter, translates only that, keeps the rest of the file.
// Judge: "Chapter N" kept as a number, title natural, nothing else changed.
const llm = pickFor('translate-title', (req: LlmRequest) =>
  (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
)

const toInput = defineTool<string, TitleTranslatorInput>({
  name: 'to-title-input',
  version: '1.0.0',
  mdDescription: 'Wraps the chapter text as a title translator request (EN -> RU).',
  async invoke(env) {
    return withItem(env, { text: env.item, sourceLang: 'English', targetLang: 'Russian' })
  },
})

export default definePipeline({ id: 'translate-title' })
  .from('md://./input/en')
  .use(keepInput)
  .use(toInput)
  .use(createTitleTranslator({ translate: llm.translate }))
  .use(
    report({
      tool: 'translate-title',
      llm,
      render: (env) => {
        const out = env.item as TitleTranslatorOutput
        return {
          output: out.text
            .split('\n')
            .filter((l) => /^#\s/.test(l) || /^title:/.test(l))
            .join('\n'),
          info: { titleTranslated: out.titleTranslated },
        }
      },
    }),
  )
  .to('md://./out/translate-title')
