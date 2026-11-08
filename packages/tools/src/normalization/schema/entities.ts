import { category, defineTool, tool } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { MAX_ENTITIES } from '../../constants.js'
import type { ChunkModeOptions } from '../../core/chunk-processor.js'
import { parseEntityRows, roundTripIssue } from './doc.js'
import type { ChapterSource } from './doc.js'
import { runExtractor } from './extractor.js'
import type { ExtractorSpec } from './extractor.js'
import type { PromptValidation, SchemaDocLlmOptions } from './llm.js'

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

const SPEC: ExtractorSpec<SchemaEntity[]> = {
  key: 'entities',
  defaults: () => ({
    systemPrompt: ENTITIES_SYSTEM_PROMPT,
    userPrompt: ENTITIES_USER_PROMPT,
  }),
  validate: (content, run) => validateEntities(content, run.source),
  // A failed chunk contributes nothing; an empty result falls back to the schema-doc block.
  partFallback: () => [],
  fallback: (run) =>
    run.source.doc.entities.length > 0 ? run.source.doc.entities : [{ index: 1, name: 'chapter' }],
  merge: (lists) => mergeEntities(lists),
  postProcess: (value, run) => (value.length > 0 ? value : SPEC.fallback(run)),
  empty: [],
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
      return runExtractor(SPEC, env, ctx, llmOptions, {
        chunkMode,
        outputReserve,
        reserve,
        splitUnit,
        chunkConcurrency,
      })
    },
  })
}

/** Entity tool with the default prompts and model. */
export const entitiesTool = createEntitiesTool()
