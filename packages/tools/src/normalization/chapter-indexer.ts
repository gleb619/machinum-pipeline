import { defineTool, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { readChapterDoc } from '../modification/chapter-doc.js'

/**
 * Extracts the chapter number from markdown frontmatter or heading.
 * Stores the parsed integer in `meta.chapterNum`, or 0 if no heading is found.
 */
export const chapterIndexer = defineTool<string, string>({
  name: 'chapter-indexer',
  version: '1.0.0',
  mdDescription:
    'Extracts chapter number from frontmatter or heading. Stores `chapterNum` in envelope metadata.',
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
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

    return withMeta(env, { chapterNum })
  },
})
