import { defineTool, withItem } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'

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
    return appendMdOutput(withItem(env, content), {
      name: 'schema-doc-mock',
      subdir: 'schema-mock',
      filename: `chapter${n}.mock.md`,
      content,
    })
  },
})
