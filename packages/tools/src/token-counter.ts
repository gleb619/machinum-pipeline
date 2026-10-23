import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

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
    const mod: any = await import('tiktoken' as any)
    const get_encoding = mod.get_encoding
    const encoder = get_encoding('cl100k_base')
    const tokens = encoder.encode(textInput)
    const tokenCount = tokens.length
    if (typeof encoder.free === 'function') {
      encoder.free()
    }
    return {
      item: env.item,
      meta: {
        ...env.meta,
        tokenCount,
      },
    }
  },
})