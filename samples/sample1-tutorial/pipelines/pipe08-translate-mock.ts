import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { definePipeline, defineTool, getVariable, withItem } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import {
  type ParagraphTranslatorInput,
  type ParagraphTranslatorOutput,
  type TitleTranslatorInput,
  type TitleTranslatorOutput,
  chapterNumberOf,
  chapterPairsLinter,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  createParagraphTranslator,
  createTitleTranslator,
  createTranslateOutputs,
  onlyChapters,
} from '@mt/tools'
import '@mt/waypoint'
import { ROOT, pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'
import { mockTranslate, translateChapter } from '../lib/translate.js'

/**
 * PIPE 08 — glossary-aware EN → RU translation, offline by default.
 *
 * Default pipeline (sample4-style):
 *   chapters/en-tagged → batch(5) → titles → body line by line → parity lint → chapters/ru
 *
 * - Titles are translated in one batch of five chapters (`createGlossaryTitleTranslator`).
 * - Every body line is one LLM call. The prompt carries only the glossary terms tagged in that
 *   line, plus the chapter summary as context. A reply that breaks line parity is a retryable
 *   error; lines that already passed are memoised, so a retry re-sends only the bad line.
 * - `chapterPairsLinter` checks the whole EN/RU pair before `createTranslateOutputs` writes
 *   `chapters/ru/chapter<N>.md` and the merged `chapters/titles.json`.
 *
 * `MT_TRANSLATE_PROMPT_LOG=<file>` records every prompt (mock backend), which is how the test
 * proves the glossary and summary reached the model. The tests run entirely offline.
 */
const CHAPTERS = join(ROOT, 'chapters')

let mockCalls = 0
/** Offline mock: Latin words become "слово"; brackets, digits and punctuation stay. */
function mockAnswer(req: LlmRequest): string {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  mockCalls += 1
  // MT_MOCK_FLAKY=1: the third answer is empty → the line check rejects it and the engine retries.
  if (process.env.MT_MOCK_FLAKY === '1' && mockCalls === 3) return ''
  return user.replace(/[A-Za-z]+/g, 'слово')
}

const llm = pickFor('translate', mockAnswer)
const only = onlyChapters()

export const translatePipeline = definePipeline({ id: 'pipe08-translate' })
  .from('md://./chapters/en-tagged')
  .flatMap(async (md: unknown) => {
    const text = String(md)
    return only && !only.has(chapterNumberOf(text, 0)) ? [] : [text]
  })
  .batch(5)
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }),
    }),
  )
  .use(createChapterBodyTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }))
  .use(chapterPairsLinter)
  .use(createTranslateOutputs({ chaptersDir: CHAPTERS }))
  .to('@chapters')

// --- work-mode demos on the two gallery chapters (plain | xml | properties) ----------------

function modePipeline(mode: 'plain' | 'xml' | 'properties') {
  const picked = pickFor(`translate-${mode}`, mockTranslate(mode))
  return definePipeline({ id: `pipe08-translate-${mode}` })
    .from('md://./fixtures/gallery')
    .use(keepInput)
    .use(translateChapter(picked, mode))
    .use(
      report({
        tool: `translate-${mode}`,
        llm: picked,
        render: (env) => ({
          output: String(env.item),
          info: { mode: getVariable(env, 'translateMode') },
        }),
      }),
    )
    .to(`md://./chapters/translate-${mode}`)
}

export const plainModePipeline = modePipeline('plain')
export const xmlModePipeline = modePipeline('xml')
export const propertiesModePipeline = modePipeline('properties')

// --- the generic paragraph / title translators (sample5 gallery) ---------------------------

const paragraphLlm = pickFor('translate-paragraphs', (req: LlmRequest) =>
  (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
)

const titleLlm = pickFor('translate-title', (req: LlmRequest) =>
  (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
)

const toParagraphInput = defineTool<string, ParagraphTranslatorInput>({
  name: 'pipe08-to-paragraph-input',
  version: '1.0.0',
  mdDescription: 'Wraps the chapter text as a paragraph translator request (EN → RU).',
  async invoke(env) {
    return withItem(env, { text: env.item, sourceLang: 'English', targetLang: 'Russian' })
  },
})

const toTitleInput = defineTool<string, TitleTranslatorInput>({
  name: 'pipe08-to-title-input',
  version: '1.0.0',
  mdDescription: 'Wraps the chapter text as a title translator request (EN → RU).',
  async invoke(env) {
    return withItem(env, { text: env.item, sourceLang: 'English', targetLang: 'Russian' })
  },
})

export const paragraphsPipeline = definePipeline({ id: 'pipe08-translate-paragraphs' })
  .from('md://./fixtures/gallery')
  .use(keepInput)
  .use(toParagraphInput)
  .use(createParagraphTranslator({ translate: paragraphLlm.translate, concurrency: 1 }))
  .use(
    report({
      tool: 'translate-paragraphs',
      llm: paragraphLlm,
      render: (env) => {
        const out = env.item as ParagraphTranslatorOutput
        return { output: out.text, info: { paragraphsTranslated: out.paragraphsTranslated } }
      },
    }),
  )
  .to('md://./chapters/translate-paragraphs')

export const titlePipeline = definePipeline({ id: 'pipe08-translate-title' })
  .from('md://./fixtures/gallery')
  .use(keepInput)
  .use(toTitleInput)
  .use(createTitleTranslator({ translate: titleLlm.translate }))
  .use(
    report({
      tool: 'translate-title',
      llm: titleLlm,
      render: (env) => {
        const out = env.item as TitleTranslatorOutput
        return {
          output: out.text
            .split('\n')
            .filter((line) => /^#\s/.test(line) || /^title:/.test(line))
            .join('\n'),
          info: { titleTranslated: out.titleTranslated },
        }
      },
    }),
  )
  .to('md://./chapters/translate-title')

export default translatePipeline
