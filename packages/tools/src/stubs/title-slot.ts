import { defineTool, withItem } from '@mt/core'
import type { TitleTranslatorState } from '../modification/chapter-translator.js'

/**
 * Stub title translation slot for dry runs.
 * Wraps translated title in mock markers instead of actual translation.
 * Used with `.with({ translate: stubTitleTranslateSlot })` on `titleTranslator`.
 */
export const stubTitleTranslateSlot = defineTool<TitleTranslatorState, TitleTranslatorState>({
  name: 'stub-title-translate-slot',
  version: '1.0.0',
  mdDescription: 'Dry-run title translation slot that wraps output in mock markers',
  invoke: async (env, _ctx) =>
    withItem(
      env,
      env.item.title
        ? { ...env.item, translatedTitle: `[mock]${env.item.title}[/mock]` }
        : env.item,
    ),
})
