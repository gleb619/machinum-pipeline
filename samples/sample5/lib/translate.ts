import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExchange, defineTool, setVariable, withItem } from '@mt/core'
import type { Exchange, Tool } from '@mt/core'
import {
  type Glossary,
  type LlmChoice,
  type LlmRequest,
  type TranslateWorkMode,
  cleanTranslation,
  createGlossaryTitleTranslator,
  parseGlossary,
  parseTranslationReply,
  tagTerms,
  titleOf,
  translateTaggedChapter,
} from '@mt/tools'
import { ROOT } from './llm.js'

// Shared by the translate-* and proofread pipelines: glossary-aware EN -> RU chapter translation
// in one of the work modes (plain | xml | properties) of `buildTranslationPrompt`.

/** Directory with the fixture glossary (`glossary.json`), also read by the title translator. */
export const INPUT_DIR = join(ROOT, 'input')

export const GLOSSARY: Glossary = parseGlossary(
  readFileSync(join(INPUT_DIR, 'glossary.json'), 'utf-8'),
) ?? { terms: [] }

const RU = (text: string) => text.replace(/[A-Za-z]+/g, 'слово')

/** Offline mock: every English word becomes "слово", in the reply format of the work mode. */
export function mockTranslate(mode: TranslateWorkMode): (req: LlmRequest) => string {
  return (req) => {
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const body = /<context>\n([\s\S]*?)\n<\/context>/.exec(user)?.[1] ?? user
    if (mode === 'xml') {
      return body
        .split('\n')
        .map((line) => /<id>(\d+)<\/id><origin>([\s\S]*)<\/origin>/.exec(line))
        .map((m) =>
          m ? `<result><id>${m[1]}</id><translated>${RU(m[2] ?? '')}</translated></result>` : '',
        )
        .join('\n')
    }
    return RU(body)
  }
}

/**
 * Translates a whole chapter: title through the glossary title translator, then every body line
 * on its own (`translateTaggedChapter`: glossary terms of that line only, line-parity check).
 * Output item = RU markdown; variable `translateMode` tells which mode produced it.
 */
export function translateChapter(llm: LlmChoice, mode: TranslateWorkMode): Tool<string, string> {
  const titleTranslator = createGlossaryTitleTranslator({
    call: llm.schemaCall,
    chaptersDir: INPUT_DIR,
    mode,
  })
  return defineTool<string, string>({
    name: `translate-chapter-${mode}`,
    version: '1.0.0',
    mdDescription: `Glossary-aware chapter translation, work mode '${mode}'.`,
    async invoke(env: Exchange<string>, ctx) {
      const heading = /^#\s+.+$/m.exec(env.item)?.[0] ?? '# Untitled'
      const title = await titleTranslator.invoke(
        createExchange({ text: heading, targetLang: 'ru', sourceLang: 'en' }),
        ctx,
      )
      const ru = await translateTaggedChapter(tagTerms(env.item, GLOSSARY), {
        glossary: GLOSSARY,
        summary: '',
        titleRu: titleOf(title.item.translatedText),
        concurrency: 1,
        mode,
        ask: async (system, user) => {
          const res = await llm.schemaCall(
            {
              systemPrompt: system,
              messages: [{ role: 'user', content: user }],
              temperature: 0.2,
              maxTokens: 2048,
            },
            ctx,
          )
          return mode === 'plain'
            ? cleanTranslation(res.content)
            : parseTranslationReply(res.content, mode).lines.join('\n')
        },
      })
      return setVariable(withItem(env, ru), 'translateMode', mode)
    },
  })
}
