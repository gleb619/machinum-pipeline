import { defineTool, setVariable } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/** Variable holding the word count. */
export const VAR_WORD_COUNT = 'wordCount'

/**
 * Counts words in a string envelope item (split by whitespace, filter empty).
 * Adds `wordCount` to the envelope meta.
 */
export const wordCounter = defineTool<string, string>({
  name: 'word-counter',
  version: '1.0.0',
  mdDescription: 'Counts words in a string envelope. Adds `wordCount` to envelope metadata.',
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    const wordCount = env.item.split(/\s+/).filter(Boolean).length
    return setVariable(env, VAR_WORD_COUNT, wordCount)
  },
})
