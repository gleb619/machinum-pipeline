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
    let chapterNum: number | undefined

    try {
      const doc = readChapterDoc(env.item)
      const titleMatch = doc.title.match(/Chapter\s+(\d+)/i)
      chapterNum = doc.number ?? (titleMatch?.[1] ? Number.parseInt(titleMatch[1], 10) : undefined)
    } catch {
      const chapterMatch = env.item.match(/^#\s*Chapter\s*(\d+)/im)
      chapterNum = chapterMatch?.[1] ? Number.parseInt(chapterMatch[1], 10) : undefined
    }

    return withMeta(env, { chapterNum: chapterNum ?? 0 })
  },
})
