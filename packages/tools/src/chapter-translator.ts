import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
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
 * Extract the title from a chapter body.
 * The title is the first H1 heading line, or the first non-empty line
 * if no H1 is found.
 */
function extractTitle(text: string): { title: string; rest: string } {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const h1 = line.match(/^#\s+(.+)/)
    if (h1) {
      const title = h1[1] as string
      const rest = lines.slice(i + 1).join('\n')
      return { title, rest }
    }
  }
  // Fallback: first non-empty line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim()) {
      const rest = lines.slice(i + 1).join('\n')
      return { title: line, rest }
    }
  }
  return { title: '', rest: text }
}

/**
 * Split text into paragraphs separated by double-newlines.
 * Preserves the blank-line structure.
 */
function splitParagraphs(text: string): string[] {
  // Split on \n\n (one or more blank lines)
  const raw = text.split(/\n{2,}/)
  // Re-attach the trailing newlines that were consumed by split
  // We keep paragraphs as-is; reassembly adds back double-newlines
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
      const { title, rest } = extractTitle(text)

      if (!title.trim()) {
        results.push({ text, titleTranslated: false })
        continue
      }

      // Reconstruct the H1 line to translate just the title portion
      const h1Line = `# ${title}`

      const translateResult = await translateText.invoke(
        {
          item: { text: h1Line, targetLang, sourceLang },
          meta: env.meta,
        },
        ctx,
      )

      const translatedH1 = translateResult.item.translatedText
      // Strip any extra whitespace/newlines the translation may have added
      const cleanH1 = translatedH1.replace(/^#\s*/, '# ').trim()

      const rebuilt = `${cleanH1}\n${rest}`

      results.push({ text: rebuilt, titleTranslated: true })
    }

    const firstResult = results[0]
    const output = env.items ? results : (firstResult ?? { translatedText: '' })

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
    const paragraphs = splitParagraphs(text)

    if (paragraphs.length === 0) {
      return {
        item: { text, paragraphsTranslated: 0 },
        meta: env.meta,
      }
    }

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

    // Reassemble with double-newline separators
    const reassembled = translatedParagraphs.join('\n\n')

    return {
      item: { text: reassembled, paragraphsTranslated: translatedParagraphs.length },
      meta: {
        ...env.meta,
        paragraphsTranslated: translatedParagraphs.length,
      },
    }
  },
})
