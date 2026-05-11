import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

/**
 * Extracts the chapter number from a Markdown heading matching `# Chapter <N>`.
 * Stores the parsed integer in `meta.chapterNum`, or 0 if no heading is found.
 */
export const chapterIndexer = defineTool<string, string>({
  name: 'chapter-indexer',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const chapterMatch = env.item.match(/^#\s*Chapter\s*(\d+)/m)
    const chapterNum = chapterMatch?.[1] ? Number.parseInt(chapterMatch[1], 10) : 0
    return {
      item: env.item,
      meta: {
        ...env.meta,
        chapterNum,
      },
    }
  },
})
