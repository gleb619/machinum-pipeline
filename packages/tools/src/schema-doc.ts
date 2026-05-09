import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

export interface SchemaDocEnvelope {
  title: string
  summary: string
  entities: { index: number; name: string }[]
  schema?: string
  frontmatter?: Record<string, unknown>
}

/** Tool: extracts the body (after title) and stores as 'summary' in meta */
export const summaryTool = defineTool<string, string>({
  name: 'summary',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const body = (env.item as string).replace(/^#\s*Chapter\s*\d+.*\n\n?/, '').trim()
    return { ...env, meta: { ...env.meta, summary: body } }
  },
})

/** Tool: adds default 'entities' to meta */
export const entitiesTool = defineTool<string, string>({
  name: 'entities',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    return {
      ...env,
      meta: { ...env.meta, entities: [{ index: 1, name: 'chapter' }] },
    }
  },
})

/** Tool: generates a mermaid schema string from the chapter heading and stores it in meta */
export const schemaTool = defineTool<string, string>({
  name: 'schema',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const headingMatch = (env.item as string).match(/^#\s*(.+)/m)
    const titleText = headingMatch?.[1]?.replace(/^Chapter \d+: /, '') || 'Unknown'
    const mermaid = `graph TD\n    ${titleText} --> Next`
    return { ...env, meta: { ...env.meta, schema: mermaid } }
  },
})
