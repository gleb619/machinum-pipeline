import { defineTool } from '@mt/core'
import { setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { chapterVars, parseEntityRows, readChapter, renderPrompt, roundTripIssue } from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const ENTITIES_SYSTEM_PROMPT =
  'You extract named entities (people, places, organisations, works, products) from a chapter. ' +
  'Reply in CSV only: a header row `index,name`, then one row per entity with a 1-based integer ' +
  'index and the entity name. No code fence, no prose, no markdown headings.'

export const ENTITIES_USER_PROMPT =
  'List the named entities that appear in this chapter, most important first, at most 40 rows.\n\n' +
  '# {{title}}\n\n{{body}}'

const MAX_ENTITIES = 200

export interface SchemaEntity {
  index: number
  name: string
}

function validateEntities(
  content: string,
  source: ChapterSource,
): PromptValidation<SchemaEntity[]> {
  const entities = parseEntityRows(content)
  if (entities.length === 0) {
    return {
      ok: false,
      reason:
        'no entity rows found - reply with CSV rows shaped `index,name` (e.g. `1,Sir Aldric`)',
    }
  }
  if (entities.length > MAX_ENTITIES) {
    return {
      ok: false,
      reason: `${entities.length} entities is more than the ${MAX_ENTITIES} accepted - keep the most important ones`,
    }
  }

  const body = source.body.toLowerCase()
  const grounded = entities.filter((entity) => body.includes(entity.name.toLowerCase()))
  if (grounded.length === 0) {
    return {
      ok: false,
      reason: `none of the entities appear in the chapter - you invented: ${entities
        .slice(0, 5)
        .map((entity) => entity.name)
        .join(', ')}`,
    }
  }

  const parseIssue = roundTripIssue(
    { ...source.doc, entities: grounded },
    (doc) => doc.entities,
    'entities',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  return { ok: true, value: grounded }
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: ENTITIES_SYSTEM_PROMPT,
  userPrompt: ENTITIES_USER_PROMPT,
}

/**
 * Builds the LLM-backed entity extractor.
 *
 * Per-envelope overrides come from variable `schemaDocLlm` or variable `entitiesPrompt` /
 * variable `entitiesSystemPrompt`. Fallback order when the loop guard is exhausted:
 * the schema-doc `## Entities` CSV, then a single `chapter` placeholder entity.
 */
export function createEntitiesTool(options?: SchemaDocLlmOptions) {
  return defineTool<string, string>({
    name: 'entities',
    version: '1.1.0',
    mdDescription:
      'Extracts named entities from the chapter with an LLM through the OpenRouter proxy, as CSV ' +
      'rows (`index,name`). Loop-guarded retries fall back to the schema-doc Entities block, then a ' +
      'default entity. Stores variable `entities`.',
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...options }, env, 'entities')
      const inputs = env.items ?? [env.item]

      const collected: SchemaEntity[][] = []
      const results: PromptRetryResult<SchemaEntity[]>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(
            resolved.systemPrompt ?? ENTITIES_SYSTEM_PROMPT,
            chapterVars(source),
          ),
          userPrompt: renderPrompt(
            resolved.userPrompt ?? ENTITIES_USER_PROMPT,
            chapterVars(source),
          ),
          validate: (content) => validateEntities(content, source),
        })
        const fallback =
          source.doc.entities.length > 0 ? source.doc.entities : [{ index: 1, name: 'chapter' }]
        collected.push(outcome.ok && outcome.value ? outcome.value : fallback)
        results.push(outcome)
      }

      const values: Record<string, unknown> = {
        entities: collected[0] ?? [],
        entitiesLlm: attemptMeta(results),
      }
      if (env.items) {
        values.entitiesByItem = collected
      }
      return setVariables(env, values)
    },
  })
}

/** Entity tool with the default prompts and model. */
export const entitiesTool = createEntitiesTool()
