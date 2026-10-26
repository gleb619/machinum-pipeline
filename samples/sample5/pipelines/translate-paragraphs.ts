import { definePipeline, defineTool, withItem } from '@mt/core'
import {
  type LlmRequest,
  type ParagraphTranslatorInput,
  type ParagraphTranslatorOutput,
  createParagraphTranslator,
} from '@mt/tools'
import '@mt/waypoint'
import { pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === translate-paragraphs: the generic paragraph translator (createParagraphTranslator) ===
// Plain `translate.system` / `translate.user` prompts, no glossary, no work modes: one LLM call
// per paragraph. Baseline for the glossary-aware `translate-*` pipelines.
// Judge: paragraph count in = out, meaning kept, names transliterated consistently.
const llm = pickFor('translate-paragraphs', (req: LlmRequest) =>
  (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
)

const toInput = defineTool<string, ParagraphTranslatorInput>({
  name: 'to-paragraph-input',
  version: '1.0.0',
  mdDescription: 'Wraps the chapter text as a paragraph translator request (EN -> RU).',
  async invoke(env) {
    return withItem(env, { text: env.item, sourceLang: 'English', targetLang: 'Russian' })
  },
})

export default definePipeline({ id: 'translate-paragraphs' })
  .from('md://./input/en')
  .use(keepInput)
  .use(toInput)
  .use(createParagraphTranslator({ translate: llm.translate, concurrency: 1 }))
  .use(
    report({
      tool: 'translate-paragraphs',
      llm,
      render: (env) => {
        const out = env.item as ParagraphTranslatorOutput
        return { output: out.text, info: { paragraphsTranslated: out.paragraphsTranslated } }
      },
    }),
  )
  .to('md://./out/translate-paragraphs')
