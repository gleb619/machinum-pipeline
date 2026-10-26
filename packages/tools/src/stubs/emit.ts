import { defineTool } from '@mt/core'
import type { MdOutputEntry } from '@mt/core'

/**
 * Stub schema emit tool for dry runs.
 * Tags markdown as mock and redirects to a subfolder.
 * No actual file writes are performed by this tool (the target handles writing).
 */
export const stubSchemaEmit = defineTool<string, string>({
  name: 'stub-schema-emit',
  version: '1.0.0',
  mdDescription: 'Dry-run schema emit stub that tags content and redirects to subfolder',
  invoke: async (env, _ctx) => {
    const n = (env.meta.chapterNum as number | undefined) ?? 1
    const content = `<!-- mock-emit -->\n${env.item}`
    const existing = (env.meta.mdOutputs as MdOutputEntry[] | undefined) ?? []
    const mdOutputs = [
      ...existing,
      {
        name: 'schema-doc-mock',
        subdir: 'schema-mock',
        filename: `chapter${n}.mock.md`,
        content,
      },
    ]
    return { item: content, meta: { ...env.meta, mdOutputs } }
  },
})
