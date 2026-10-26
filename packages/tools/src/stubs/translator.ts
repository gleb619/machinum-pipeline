import { defineTool } from '@mt/core'

/**
 * Stub translation tool for dry runs.
 * Wraps paragraphs in language markers (e.g., [ru]...[/ru]) instead of actual translation.
 * No API calls, no LLM dependencies.
 */
export const stubTranslator = defineTool<string, string>({
  name: 'stub-translator',
  version: '1.0.0',
  mdDescription: 'Dry-run translation stub that wraps text in language markers',
  invoke: async (env, _ctx) => {
    const text = env.item as string
    const translated = text
      .split('\n\n')
      .map((p) => `[ru]${p}[/ru]`)
      .join('\n\n')
    return { ...env, item: translated, meta: { ...env.meta, translated: true, lang: 'ru' } }
  },
})
