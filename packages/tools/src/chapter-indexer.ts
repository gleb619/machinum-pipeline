import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { readChapterDoc } from './chapter-doc.js'

/**
 * Extracts the chapter number from markdown frontmatter or heading.
 * Stores the parsed integer in `meta.chapterNum`, or 0 if no heading is found.
 */
export const chapterIndexer = defineTool<string, string>({
  name: 'chapter-indexer',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    let chapterNum = 0

    try {
      const doc = readChapterDoc(env.item)
      chapterNum = doc.number

      if (chapterNum === 1) {
        const titleMatch = doc.title.match(/Chapter\s+(\d+)/i)
        if (titleMatch?.[1]) {
          chapterNum = Number.parseInt(titleMatch[1], 10)
        }
      }
    } catch {
      const chapterMatch = env.item.match(/^#\s*Chapter\s*(\d+)/im)
      chapterNum = chapterMatch?.[1] ? Number.parseInt(chapterMatch[1], 10) : 0
    }

    return {
      item: env.item,
      meta: {
        ...env.meta,
        chapterNum,
      },
    }
  },
})
