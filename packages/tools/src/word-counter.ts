import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

/**
 * Counts words in a string envelope item (split by whitespace, filter empty).
 * Adds `wordCount` to the envelope meta.
 */
export const wordCounter = defineTool<string, string>({
  name: 'word-counter',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const wordCount = env.item.split(/\s+/).filter(Boolean).length
    return {
      item: env.item,
      meta: {
        ...env.meta,
        wordCount,
      },
    }
  },
})
