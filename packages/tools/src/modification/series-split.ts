import { defineTool, setVariables, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { SERIES_SPLIT_PARTS } from '../constants.js'
import { balanceText } from '../normalization/token-splitter.js'

export interface SeriesSplitOptions {
  parts: number
}

export function createSeriesSplitTool(options: SeriesSplitOptions = { parts: SERIES_SPLIT_PARTS }) {
  return defineTool<string, string[]>({
    name: 'series-split',
    version: '1.0.0',
    mdDescription: 'Split a big chapter into equal series parts with series frontmatter.',
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string[]>> {
      const input = env.item
      const titleMatch = input.match(/^#\s+(.+)$/m)
      const title = titleMatch?.[1]?.trim() ?? 'Untitled'
      const chunks = balanceText(input, options.parts)
      const parts = chunks.map((chunk, i) => {
        const fm = `---\nseries: ${title}\npart: ${i + 1}/${chunks.length}\n---\n\n`
        return `${fm}${chunk}`
      })
      return setVariables(withItem(env, parts), { series: title, partCount: parts.length })
    },
  })
}

export const seriesSplitTool = createSeriesSplitTool()
