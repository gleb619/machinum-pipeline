import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { type ChapterDoc, readChapterDoc, writeChapterDoc } from './chapter-doc.js'
import { translateText } from './translate-text.js'

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface TitleTranslatorInput {
  text: string
  targetLang: string
  sourceLang?: string
}

export interface TitleTranslatorOutput {
  text: string
  titleTranslated: boolean
}

export interface ParagraphTranslatorInput {
  text: string
  targetLang: string
  sourceLang?: string
}

export interface ParagraphTranslatorOutput {
  text: string
  paragraphsTranslated: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split text into paragraphs separated by double-newlines.
 * Preserves the blank-line structure.
 */
function splitParagraphs(text: string): string[] {
  const raw = text.split(/\n{2,}/)
  return raw.filter((p) => p.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Tool 1: Title Translator
// ---------------------------------------------------------------------------

export const titleTranslator = defineTool<TitleTranslatorInput, TitleTranslatorOutput>({
  name: 'title-translator',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(
    env: Envelope<TitleTranslatorInput>,
    ctx: ToolContext,
  ): Promise<Envelope<TitleTranslatorOutput>> {
    const inputs = env.items ?? [env.item]
    const results: TitleTranslatorOutput[] = []

    for (const input of inputs) {
      const { text, targetLang, sourceLang } = input

      try {
        const doc = readChapterDoc(text)

        if (!doc.title.trim()) {
          results.push({ text, titleTranslated: false })
          continue
        }

        const translateResult = await translateText.invoke(
          {
            item: { text: doc.title, targetLang, sourceLang },
            meta: env.meta,
          },
          ctx,
        )

        const translatedTitle = translateResult.item.translatedText

        const rebuilt = await writeChapterDoc({ ...doc, title: translatedTitle })

        results.push({ text: rebuilt, titleTranslated: true })
      } catch {
        // Fallback to legacy regex-based extraction
        const lines = text.split('\n')
        let found = false
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string
          const h1 = line.match(/^#\s+(.+)/)
          if (h1) {
            const title = h1[1] as string
            const rest = lines.slice(i + 1).join('\n')

            const translateResult = await translateText.invoke(
              {
                item: { text: title, targetLang, sourceLang },
                meta: env.meta,
              },
              ctx,
            )

            const cleanH1 = `# ${translateResult.item.translatedText.trim()}`
            const rebuilt = `${cleanH1}\n${rest}`

            results.push({ text: rebuilt, titleTranslated: true })
            found = true
            break
          }
        }

        if (!found) {
          // Fallback: first non-empty line
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] as string
            if (line.trim()) {
              const rest = lines.slice(i + 1).join('\n')

              const translateResult = await translateText.invoke(
                {
                  item: { text: line, targetLang, sourceLang },
                  meta: env.meta,
                },
                ctx,
              )

              const rebuilt = `${translateResult.item.translatedText.trim()}\n${rest}`

              results.push({ text: rebuilt, titleTranslated: true })
              found = true
              break
            }
          }
        }

        if (!found) {
          results.push({ text, titleTranslated: false })
        }
      }
    }

    const firstResult = results[0]
    const output = env.items ? results : (firstResult ?? { text: '', titleTranslated: false })

    return {
      item: output as TitleTranslatorOutput,
      meta: {
        ...env.meta,
        titleTranslated: true,
        count: results.length,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 2: Paragraph Translator
// ---------------------------------------------------------------------------

export const paragraphTranslator = defineTool<ParagraphTranslatorInput, ParagraphTranslatorOutput>({
  name: 'paragraph-translator',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(
    env: Envelope<ParagraphTranslatorInput>,
    ctx: ToolContext,
  ): Promise<Envelope<ParagraphTranslatorOutput>> {
    const { text, targetLang, sourceLang } = env.item

    try {
      const doc = readChapterDoc(text)
      const translatedBody: ChapterDoc['body'] = []

      for (const paragraph of doc.body) {
        const paraText = paragraph.lines.join(' ')

        const translateResult = await translateText.invoke(
          {
            item: { text: paraText, targetLang, sourceLang },
            meta: env.meta,
          },
          ctx,
        )

        const lines = translateResult.item.translatedText.split('\n').filter((l) => l.length > 0)
        translatedBody.push({ lines })
      }

      const rebuilt = await writeChapterDoc({ ...doc, body: translatedBody })

      return {
        item: { text: rebuilt, paragraphsTranslated: translatedBody.length },
        meta: {
          ...env.meta,
          paragraphsTranslated: translatedBody.length,
        },
      }
    } catch {
      // Fallback to legacy paragraph splitting
      const paragraphs = splitParagraphs(text)
      const translatedParagraphs: string[] = []

      for (const para of paragraphs) {
        const translateResult = await translateText.invoke(
          {
            item: { text: para, targetLang, sourceLang },
            meta: env.meta,
          },
          ctx,
        )
        translatedParagraphs.push(translateResult.item.translatedText)
      }

      const reassembled = translatedParagraphs.join('\n\n')

      return {
        item: { text: reassembled, paragraphsTranslated: translatedParagraphs.length },
        meta: {
          ...env.meta,
          paragraphsTranslated: translatedParagraphs.length,
        },
      }
    }
  },
})
