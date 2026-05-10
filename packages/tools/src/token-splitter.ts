// Requires gpt-tokenizer npm package to be added to dependencies
import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

const MAX_TOKENS = 12000
const CHUNK_TARGET = 6000

/**
 * Heuristic fallback: ~4 characters per token.
 */
function heuristicTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Count tokens using gpt-tokenizer if available, otherwise use heuristic.
 */
async function countTokens(text: string): Promise<number> {
  try {
    const { encode } = await import('gpt-tokenizer')
    return encode(text).length
  } catch {
    return heuristicTokenCount(text)
  }
}

/**
 * Split text at paragraph boundaries (double-newline) into chunks of
 * approximately CHUNK_TARGET tokens each. Uses heuristic counting for
 * the iterative accumulation to avoid repeated async calls.
 */
function splitAtParagraphs(text: string): string[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let currentChunk = ''
  let currentTokens = 0

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue
    const paragraphTokens = heuristicTokenCount(paragraph)

    if (currentTokens > 0 && currentTokens + paragraphTokens > CHUNK_TARGET) {
      chunks.push(currentChunk.trimEnd())
      currentChunk = paragraph
      currentTokens = paragraphTokens
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph
      currentTokens += paragraphTokens
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd())
  }

  return chunks.length > 0 ? chunks : [text]
}

export const tokenSplitter = defineTool<string, string[]>({
  name: 'token-splitter',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string[]>> {
    const inputs: string[] = env.items ?? [env.item]
    const allChunks: string[] = []

    for (const input of inputs) {
      const tokenCount = await countTokens(input)
      if (tokenCount <= MAX_TOKENS) {
        allChunks.push(input)
      } else {
        const subChapters = splitAtParagraphs(input)
        for (const chunk of subChapters) {
          allChunks.push(chunk)
        }
      }
    }

    return {
      item: allChunks,
      meta: {
        ...env.meta,
        split: allChunks.length > inputs.length,
        chunkCount: allChunks.length,
      },
    }
  },
})
