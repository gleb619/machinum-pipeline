import { category, defineTool, itemArg, setVariable, tool, variableArg } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/** Variable holding the word count. */
export const VAR_WORD_COUNT = 'wordCount'

/**
 * Counts words in a string envelope item (split by whitespace, filter empty).
 * Adds `wordCount` to the envelope variables.
 */
export const wordCounter = defineTool<string, string>({
  name: 'word-counter',
  version: '1.0.0',
  description: 'Counts words in a string envelope. Sets the `wordCount` variable.',
  annotations: [
    tool('TL012', {
      name: 'word-counter',
      description: 'Counts words and stores the wordCount variable.',
      refs: [],
    }),
    category(['statistics']),
  ],
  args: [
    itemArg({ type: 'string', description: 'text to count words in' }),
    variableArg({
      name: 'wordCount',
      type: 'number',
      direction: 'out',
      description: 'word count set as an output variable',
    }),
  ],
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    const wordCount = env.item.split(/\s+/).filter(Boolean).length
    return setVariable(env, VAR_WORD_COUNT, wordCount)
  },
})
