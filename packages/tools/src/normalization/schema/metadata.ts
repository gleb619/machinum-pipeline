import { defineTool } from '@mt/core'
import { setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import type { SchemaDocMetadata } from '../../modification/schema-doc.js'
import {
  chapterVars,
  metadataGroundTruth,
  parseMetadataRow,
  readChapter,
  renderPrompt,
  roundTripIssue,
} from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const METADATA_SYSTEM_PROMPT =
  'You fill the Metadata table of a schema document. Reply with exactly one markdown table: the ' +
  'header row `| chapter | wordCount | tokenCount | charLength |`, a separator row, then one row of ' +
  'four non-negative integers. Use the measured values you were given verbatim. No prose.'

export const METADATA_USER_PROMPT =
  'Build the Metadata table for this chapter.\n\n' +
  'Measured values to reuse verbatim: chapter={{chapter}} wordCount={{wordCount}} ' +
  'tokenCount={{tokenCount}} charLength={{charLength}}\n\n' +
  '# {{title}}\n\n{{body}}'

const FIELD_LABELS: Record<keyof SchemaDocMetadata, string> = {
  chapter: 'chapter',
  wordCount: 'wordCount',
  tokenCount: 'tokenCount',
  charLength: 'charLength',
}

function validateMetadata(
  content: string,
  source: ChapterSource,
  truth: SchemaDocMetadata,
): PromptValidation<SchemaDocMetadata> {
  const parsed = parseMetadataRow(content)
  if (!parsed) {
    return {
      ok: false,
      reason:
        'no metadata row found - reply with one markdown table row of four integers: ' +
        '| chapter | wordCount | tokenCount | charLength |',
    }
  }

  const wrong = (Object.keys(FIELD_LABELS) as (keyof SchemaDocMetadata)[]).filter(
    (field) => parsed[field] !== truth[field],
  )
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: `you did not use the measured values: ${wrong
        .map(
          (field) => `${FIELD_LABELS[field]} must be ${truth[field]}, you wrote ${parsed[field]}`,
        )
        .join('; ')}`,
    }
  }

  const parseIssue = roundTripIssue(
    { ...source.doc, metadata: parsed },
    (doc) => doc.metadata,
    'metadata',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  return { ok: true, value: parsed }
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: METADATA_SYSTEM_PROMPT,
  userPrompt: METADATA_USER_PROMPT,
}

/**
 * Builds the metadata tool.
 *
 * The four counters are known facts (run meta, the document itself, or the item
 * length), so they are handed to the model as ground truth and the loop guard
 * rejects any answer that rewrites them; the deterministic row is used when the
 * guard is exhausted. Per-envelope overrides: variable `schemaDocLlm`,
 * variable `metadataPrompt` / variable `metadataSystemPrompt`.
 */
export function createMetadataTool(options?: SchemaDocLlmOptions) {
  return defineTool<string, string>({
    name: 'metadata',
    version: '1.1.0',
    mdDescription:
      'Extracts the schema-doc Metadata row (chapter, wordCount, tokenCount, charLength) with an ' +
      'LLM through the OpenRouter proxy, validated against the measured values and falling back to ' +
      'the deterministic row. Stores variable `metadata`.',
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...options }, env, 'metadata')
      const inputs = env.items ?? [env.item]

      const rows: SchemaDocMetadata[] = []
      const results: PromptRetryResult<SchemaDocMetadata>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const truth = metadataGroundTruth(env, source, input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(resolved.systemPrompt ?? METADATA_SYSTEM_PROMPT, {
            ...chapterVars(source),
            chapter: truth.chapter,
            wordCount: truth.wordCount,
            tokenCount: truth.tokenCount,
            charLength: truth.charLength,
          }),
          userPrompt: renderPrompt(resolved.userPrompt ?? METADATA_USER_PROMPT, {
            ...chapterVars(source),
            chapter: truth.chapter,
            wordCount: truth.wordCount,
            tokenCount: truth.tokenCount,
            charLength: truth.charLength,
          }),
          validate: (content) => validateMetadata(content, source, truth),
        })
        rows.push(outcome.ok && outcome.value ? outcome.value : truth)
        results.push(outcome)
      }

      const values: Record<string, unknown> = {
        metadata: rows[0] ?? { chapter: 1, wordCount: 0, tokenCount: 0, charLength: 0 },
        metadataLlm: attemptMeta(results),
      }
      if (env.items) {
        values.metadataByItem = rows
      }
      return setVariables(env, values)
    },
  })
}

/** Metadata tool with the default prompts and model. */
export const metadataTool = createMetadataTool()
