import { defineTool } from '@mt/core'
import type { ParagraphTranslatorState } from '../modification/chapter-translator.js'

/**
 * Stub paragraph translation slot for dry runs.
 * Wraps each paragraph in mock markers instead of actual translation.
 * Used with `.with({ translate: stubParagraphTranslateSlot })` on `paragraphTranslator`.
 */
export const stubParagraphTranslateSlot = defineTool<
  ParagraphTranslatorState,
  ParagraphTranslatorState
>({
  name: 'stub-paragraph-translate-slot',
  version: '1.0.0',
  mdDescription: 'Dry-run paragraph translation slot that wraps output in mock markers',
  invoke: async (env, _ctx) => ({
    item: {
      ...env.item,
      translated: env.item.paragraphs.map((p: string) => `[mock]${p}[/mock]`),
    },
    meta: env.meta,
  }),
})
