import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { get_encoding } from 'tiktoken'

/**
 * Counts tokens in a string envelope item using tiktoken (cl100k_base).
 * Adds `tokenCount` to the envelope meta.
 */
export const tokenCounter = defineTool<string, string>({
  name: 'token-counter',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const textInput = env.item
    const encoder = get_encoding('cl100k_base')
    const tokens = encoder.encode(textInput)
    const tokenCount = tokens.length
    encoder.free()
    return {
      item: env.item,
      meta: {
        ...env.meta,
        tokenCount,
      },
    }
  },
})
