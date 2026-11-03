import { category, defineTool, tool } from '@mt/core'
import { setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { MAX_ENTITIES } from '../../constants.js'
import {
  type ChunkModeOptions,
  resolvePromptBudget,
  runChunkedText,
  toChunkRecord,
} from '../../core/chunk-processor.js'
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
export function createEntitiesTool(options?: SchemaDocLlmOptions & ChunkModeOptions) {
  const { chunkMode, outputReserve, reserve, splitUnit, chunkConcurrency, ...llmOptions } =
    options ?? {}

  return defineTool<string, string>({
    name: 'entities',
    version: '1.2.0',
    mdDescription:
      'Extracts named entities from the chapter with an LLM through the OpenRouter proxy, as CSV ' +
      'rows (`index,name`). Loop-guarded retries fall back to the schema-doc Entities block, then a ' +
      'default entity. Supports shrink/chunk/auto modes (entities merged and deduped across ' +
      'chunks). Stores variable `entities`.',
    annotations: [
      tool('TL107', {
        name: 'entities',
        description: 'Extracts chapter entities as CSV rows with loop-guarded LLM retries.',
        refs: [],
      }),
      category(['extractor', 'llm']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...llmOptions }, env, 'entities')
      const inputs = env.items ?? [env.item]

      const collected: SchemaEntity[][] = []
      const results: PromptRetryResult<SchemaEntity[]>[] = []
      const chunkRecords: ReturnType<typeof toChunkRecord>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const runOne = async (part: ChapterSource): Promise<SchemaEntity[]> => {
          const outcome = await runPromptWithRetry(ctx, {
            ...resolved,
            systemPrompt: renderPrompt(
              resolved.systemPrompt ?? ENTITIES_SYSTEM_PROMPT,
              chapterVars(part),
            ),
            userPrompt: renderPrompt(
              resolved.userPrompt ?? ENTITIES_USER_PROMPT,
              chapterVars(part),
            ),
            validate: (content) => validateEntities(content, part),
          })
          results.push(outcome)
          return outcome.ok && outcome.value ? outcome.value : []
        }

        const run = await runChunkedText<SchemaEntity[]>({
          mode: chunkMode,
          text: source.body,
          budget: () =>
            resolvePromptBudget(ctx, resolved, { outputReserve, reserve }, [
              renderPrompt(resolved.systemPrompt ?? ENTITIES_SYSTEM_PROMPT, {
                ...chapterVars(source),
                body: '',
              }),
              renderPrompt(resolved.userPrompt ?? ENTITIES_USER_PROMPT, {
                ...chapterVars(source),
                body: '',
              }),
            ]),
          single: () => runOne(source),
          chunk: (chunk) => runOne({ ...source, body: chunk }),
          merge: mergeEntities,
          splitUnit,
          concurrency: chunkConcurrency,
        })
        if (run.budget) chunkRecords.push(toChunkRecord(run.budget, run.chunks))

        const fallback =
          source.doc.entities.length > 0 ? source.doc.entities : [{ index: 1, name: 'chapter' }]
        collected.push(run.value.length > 0 ? run.value : fallback)
      }

      const values: Record<string, unknown> = {
        entities: collected[0] ?? [],
        entitiesLlm: attemptMeta(results),
      }
      if (env.items) {
        values.entitiesByItem = collected
      }
      if (chunkRecords.length > 0) {
        values.entitiesChunks = chunkRecords
      }
      return setVariables(env, values)
    },
  })
}

/** Merges per-chunk entity lists: first occurrence wins (case-insensitive), re-indexed, capped. */
function mergeEntities(lists: readonly SchemaEntity[][]): SchemaEntity[] {
  const seen = new Set<string>()
  const merged: SchemaEntity[] = []
  for (const list of lists) {
    for (const entity of list) {
      const key = entity.name.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push({ index: merged.length + 1, name: entity.name })
    }
  }
  return merged.slice(0, MAX_ENTITIES)
}

/** Entity tool with the default prompts and model. */
export const entitiesTool = createEntitiesTool()
