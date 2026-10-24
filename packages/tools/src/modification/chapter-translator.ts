import { defineComposableTool, defineTool } from '@mt/core'
import type { ComposableTool, Envelope, Tool, ToolContext } from '@mt/core'
import { type TranslateInput, type TranslateOutput, translateText } from '../core/translate-text.js'
import { type ChapterDoc, readChapterDoc, writeChapterDoc } from './chapter-doc.js'

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
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Single place where a translator tool is invoked: every default `translate`
 * slot goes through here instead of hand-building envelopes at each call site.
 */
async function translateVia(
  translator: Tool<TranslateInput, TranslateOutput>,
  req: TranslateInput,
  meta: Record<string, unknown>,
  ctx: ToolContext,
): Promise<TranslateOutput> {
  const res = await translator.invoke({ item: req, meta }, ctx)
  return res.item
}

function toTranslateInput(
  text: string,
  input: { targetLang: string; sourceLang?: string },
): TranslateInput {
  return { text, targetLang: input.targetLang, sourceLang: input.sourceLang }
}

/**
 * Split text into paragraphs separated by double-newlines.
 * Preserves the blank-line structure.
 */
function splitParagraphs(text: string): string[] {
  const raw = text.split(/\n{2,}/)
  return raw.filter((p) => p.trim().length > 0)
}

async function mapState<A, B>(
  env: Envelope<A>,
  fn: (item: A, index: number) => Promise<B>,
): Promise<Envelope<B>> {
  const items = env.items ?? [env.item]
  const out: B[] = []
  for (let i = 0; i < items.length; i++) {
    out.push(await fn(items[i] as A, i))
  }
  return env.items
    ? { item: out[0] as B, items: out, meta: env.meta }
    : { item: out[0] as B, meta: env.meta }
}

// ---------------------------------------------------------------------------
// Tool 1: Title Translator (slots: extract -> translate -> assemble)
// ---------------------------------------------------------------------------

export interface TitleTranslatorState {
  input: TitleTranslatorInput
  /** Where the title came from: frontmatter doc, H1 line, first line, or none. */
  mode: 'doc' | 'h1' | 'first' | 'none'
  doc?: ChapterDoc
  title?: string
  /** Remaining content after the title line (h1 / first modes). */
  rest?: string
  translatedTitle?: string
}

export type TitleTranslatorSlot = 'extract' | 'translate' | 'assemble'

export interface TitleTranslatorOptions {
  /** Translator for the title text. Default: `translateText`. */
  translate?: Tool<TranslateInput, TranslateOutput>
}

const titleExtract = defineTool<TitleTranslatorInput, TitleTranslatorState>({
  name: 'title-translator:extract',
  version: '1.0.0',
  mdDescription: 'Finds the chapter title (frontmatter, H1, or first line).',
  async invoke(env, _ctx) {
    return mapState(env, async (input) => {
      const base: TitleTranslatorState = { input, mode: 'none' }
      try {
        const doc = readChapterDoc(input.text)
        if (doc.title.trim()) return { ...base, mode: 'doc', doc, title: doc.title }
        return base
      } catch {
        // Legacy fallback: regex-based extraction from raw lines.
        const lines = input.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const h1 = (lines[i] as string).match(/^#\s+(.+)/)
          if (h1) {
            return {
              ...base,
              mode: 'h1',
              title: h1[1] as string,
              rest: lines.slice(i + 1).join('\n'),
            }
          }
        }
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string
          if (line.trim()) {
            return { ...base, mode: 'first', title: line, rest: lines.slice(i + 1).join('\n') }
          }
        }
        return base
      }
    })
  },
})

function titleTranslateSlot(
  translator: Tool<TranslateInput, TranslateOutput>,
): Tool<TitleTranslatorState, TitleTranslatorState> {
  return defineTool<TitleTranslatorState, TitleTranslatorState>({
    name: 'title-translator:translate',
    version: '1.0.0',
    mdDescription: 'Translates the extracted title via the configured translator.',
    async invoke(env, ctx) {
      return mapState(env, async (state) => {
        if (!state.title) return state
        const out = await translateVia(
          translator,
          toTranslateInput(state.title, state.input),
          env.meta,
          ctx,
        )
        return { ...state, translatedTitle: out.translatedText }
      })
    },
  })
}

const titleAssemble = defineTool<TitleTranslatorState, TitleTranslatorOutput>({
  name: 'title-translator:assemble',
  version: '1.0.0',
  mdDescription: 'Rebuilds the chapter with the translated title.',
  async invoke(env) {
    const states = env.items ?? [env.item]
    const results: TitleTranslatorOutput[] = []
    for (const state of states) {
      const translated = state.translatedTitle?.trim()
      if (state.mode === 'doc' && state.doc && translated) {
        results.push({
          text: await writeChapterDoc({ ...state.doc, title: translated }),
          titleTranslated: true,
        })
      } else if ((state.mode === 'h1' || state.mode === 'first') && translated) {
        const rebuilt = `${translated}\n${state.rest ?? ''}`
        results.push({
          text: state.mode === 'h1' ? `# ${rebuilt}` : rebuilt,
          titleTranslated: true,
        })
      } else {
        results.push({ text: state.input.text, titleTranslated: false })
      }
    }
    const anyTranslated = results.some((r) => r.titleTranslated)
    return {
      item: (env.items ? results : (results[0] as TitleTranslatorOutput)) as TitleTranslatorOutput,
      meta: {
        ...env.meta,
        titleTranslated: env.items ? results.map((r) => r.titleTranslated) : anyTranslated,
        count: results.length,
      },
    }
  },
})

/**
 * Composable title translator: slots `extract -> translate -> assemble`.
 * `.with({ translate: myTool })` swaps the translator for the whole tool.
 */
export function createTitleTranslator(
  options: TitleTranslatorOptions = {},
): ComposableTool<TitleTranslatorInput, TitleTranslatorOutput, TitleTranslatorSlot> {
  return defineComposableTool<TitleTranslatorInput, TitleTranslatorOutput, TitleTranslatorSlot>({
    name: 'title-translator',
    version: '1.0.0',
    mdDescription:
      'Translates chapter titles. Reads from frontmatter or H1 heading. ' +
      'Composable: slots extract/translate/assemble; swap the translator via `.with({ translate })`.',
    slots: {
      extract: titleExtract as Tool<never, unknown>,
      translate: titleTranslateSlot(options.translate ?? translateText) as Tool<never, unknown>,
      assemble: titleAssemble as Tool<never, unknown>,
    },
  })
}

export const titleTranslator = createTitleTranslator()

// ---------------------------------------------------------------------------
// Tool 2: Paragraph Translator (slots: split -> translate -> assemble)
// ---------------------------------------------------------------------------

export interface ParagraphTranslatorState {
  input: ParagraphTranslatorInput
  /** true when chapter-doc parsing failed and raw paragraph splitting was used. */
  legacy: boolean
  doc?: ChapterDoc
  paragraphs: string[]
  translated?: string[]
}

export type ParagraphTranslatorSlot = 'split' | 'translate' | 'assemble'

export interface ParagraphTranslatorOptions {
  /** Translator for each paragraph. Default: `translateText`. */
  translate?: Tool<TranslateInput, TranslateOutput>
}

const paragraphSplit = defineTool<ParagraphTranslatorInput, ParagraphTranslatorState>({
  name: 'paragraph-translator:split',
  version: '1.0.0',
  mdDescription: 'Splits the chapter body into paragraph texts.',
  async invoke(env, _ctx) {
    const input = env.item
    try {
      const doc = readChapterDoc(input.text)
      return {
        item: {
          input,
          legacy: false,
          doc,
          paragraphs: doc.body.map((p) => p.lines.join(' ')),
        },
        meta: env.meta,
      }
    } catch {
      return {
        item: { input, legacy: true, paragraphs: splitParagraphs(input.text) },
        meta: env.meta,
      }
    }
  },
})

function paragraphTranslateSlot(
  translator: Tool<TranslateInput, TranslateOutput>,
): Tool<ParagraphTranslatorState, ParagraphTranslatorState> {
  return defineTool<ParagraphTranslatorState, ParagraphTranslatorState>({
    name: 'paragraph-translator:translate',
    version: '1.0.0',
    mdDescription: 'Translates every paragraph via the configured translator.',
    async invoke(env, ctx) {
      const state = env.item
      const translated: string[] = []
      for (const para of state.paragraphs) {
        const out = await translateVia(
          translator,
          toTranslateInput(para, state.input),
          env.meta,
          ctx,
        )
        translated.push(out.translatedText)
      }
      return { item: { ...state, translated }, meta: env.meta }
    },
  })
}

const paragraphAssemble = defineTool<ParagraphTranslatorState, ParagraphTranslatorOutput>({
  name: 'paragraph-translator:assemble',
  version: '1.0.0',
  mdDescription: 'Rebuilds the chapter with the translated paragraphs.',
  async invoke(env) {
    const state = env.item
    const translated = state.translated ?? []
    const text = state.legacy
      ? translated.join('\n\n')
      : state.doc
        ? await writeChapterDoc({
            ...state.doc,
            body: translated.map((t) => ({
              lines: t.split('\n').filter((l) => l.length > 0),
            })),
          })
        : translated.join('\n\n')
    return {
      item: { text, paragraphsTranslated: translated.length },
      meta: { ...env.meta, paragraphsTranslated: translated.length },
    }
  },
})

/**
 * Composable paragraph translator: slots `split -> translate -> assemble`.
 * `.with({ translate: myTool })` swaps the translator for the whole tool.
 */
export function createParagraphTranslator(
  options: ParagraphTranslatorOptions = {},
): ComposableTool<ParagraphTranslatorInput, ParagraphTranslatorOutput, ParagraphTranslatorSlot> {
  return defineComposableTool<
    ParagraphTranslatorInput,
    ParagraphTranslatorOutput,
    ParagraphTranslatorSlot
  >({
    name: 'paragraph-translator',
    version: '1.0.0',
    mdDescription:
      'Translates chapter body paragraphs. Preserves paragraph structure. ' +
      'Composable: slots split/translate/assemble; swap the translator via `.with({ translate })`.',
    slots: {
      split: paragraphSplit as Tool<never, unknown>,
      translate: paragraphTranslateSlot(options.translate ?? translateText) as Tool<never, unknown>,
      assemble: paragraphAssemble as Tool<never, unknown>,
    },
  })
}

export const paragraphTranslator = createParagraphTranslator()
