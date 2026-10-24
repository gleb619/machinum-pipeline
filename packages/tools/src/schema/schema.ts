import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { chapterVars, readChapter, renderPrompt, roundTripIssue, stripCodeFence } from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const SCHEMA_SYSTEM_PROMPT =
  'You model a document chapter as a mermaid diagram. Reply with mermaid code only: a first line ' +
  'declaring `graph TD`, then one `A --> B` edge per line with short bracketed labels. ' +
  'No prose, no markdown headings, no ``` fences.'

export const SCHEMA_USER_PROMPT =
  'Describe the structure of this chapter as a mermaid graph with at most 12 nodes.\n\n' +
  '# {{title}}\n\n{{body}}'

const DIAGRAM_KEYWORD_RE =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap)\b/
const EDGE_RE = /-->|-\.->|==>|---/
const MAX_LINES = 80

/** Strips a stray mermaid fence and rejects answers that are not a diagram. */
function validateSchema(content: string, source: ChapterSource): PromptValidation<string> {
  const diagram = stripCodeFence(content, 'mermaid')
  const lines = diagram.split('\n').filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return { ok: false, reason: 'the response contains no mermaid diagram' }
  }
  const first = (lines[0] ?? '').trim()
  if (!DIAGRAM_KEYWORD_RE.test(first)) {
    return {
      ok: false,
      reason: `the diagram must start with a mermaid type declaration (got "${first}")`,
    }
  }
  if (lines.length > MAX_LINES) {
    return {
      ok: false,
      reason: `${lines.length} lines is more than the ${MAX_LINES} accepted - keep the graph smaller`,
    }
  }
  if (!lines.some((line) => EDGE_RE.test(line))) {
    return {
      ok: false,
      reason: 'the diagram has no edges - connect the nodes with `A --> B` lines',
    }
  }

  const parseIssue = roundTripIssue(
    { ...source.doc, schema: diagram },
    (doc) => doc.schema,
    'schema',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  return { ok: true, value: diagram }
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: SCHEMA_SYSTEM_PROMPT,
  userPrompt: SCHEMA_USER_PROMPT,
}

/**
 * Builds the LLM-backed mermaid schema generator.
 *
 * Per-envelope overrides come from `meta.schemaDocLlm` or `meta.schemaPrompt` /
 * `meta.schemaSystemPrompt`. Fallback order when the loop guard is exhausted: the
 * schema-doc `## Schema` block, then a generated single-edge `graph TD`.
 */
export function createSchemaTool(options?: SchemaDocLlmOptions) {
  return defineTool<string, string>({
    name: 'schema',
    version: '1.1.0',
    mdDescription:
      'Generates a mermaid structure diagram for the chapter with an LLM through the OpenRouter ' +
      'proxy. Loop-guarded retries fall back to the schema-doc Schema block, then a generated ' +
      '`graph TD`. Stores `meta.schema`.',
    exec: 'inproc',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...options }, env.meta, 'schema')
      const inputs = env.items ?? [env.item]

      const diagrams: string[] = []
      const results: PromptRetryResult<string>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(
            resolved.systemPrompt ?? SCHEMA_SYSTEM_PROMPT,
            chapterVars(source),
          ),
          userPrompt: renderPrompt(resolved.userPrompt ?? SCHEMA_USER_PROMPT, chapterVars(source)),
          validate: (content) => validateSchema(content, source),
        })
        diagrams.push(
          outcome.ok && outcome.value !== undefined ? outcome.value : fallbackDiagram(source),
        )
        results.push(outcome)
      }

      const meta: Envelope<string>['meta'] = {
        ...env.meta,
        schema: diagrams[0] ?? '',
        schemaLlm: attemptMeta(results),
      }
      if (env.items) {
        meta.schemaByItem = diagrams
      }
      return { ...env, meta }
    },
  })
}

/** Deterministic diagram: the parsed `## Schema` block, else a title-rooted graph. */
export function fallbackDiagram(source: ChapterSource): string {
  if (source.doc.schema) {
    return source.doc.schema
  }
  const titleText = source.doc.title.replace(/^Chapter \d+: /, '') || 'Unknown'
  return `graph TD\n    ${titleText} --> Next`
}

/** Schema tool with the default prompts and model. */
export const schemaTool = createSchemaTool()
