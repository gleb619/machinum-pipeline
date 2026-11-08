import { category, defineTool, tool } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import type { SchemaDocMetadata } from '../../modification/schema-doc.js'
import { metadataGroundTruth, parseMetadataRow, roundTripIssue } from './doc.js'
import type { ChapterSource } from './doc.js'
import { runExtractor } from './extractor.js'
import type { ExtractorRun, ExtractorSpec } from './extractor.js'
import type { PromptValidation, SchemaDocLlmOptions } from './llm.js'

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

/** The measured counters of one item: the ground truth of the Metadata row. */
function truthOf(run: ExtractorRun): SchemaDocMetadata {
  return metadataGroundTruth(run.env, run.source, run.item)
}

const SPEC: ExtractorSpec<SchemaDocMetadata> = {
  key: 'metadata',
  defaults: () => ({
    systemPrompt: METADATA_SYSTEM_PROMPT,
    userPrompt: METADATA_USER_PROMPT,
  }),
  vars: (run) => {
    const truth = truthOf(run)
    return {
      chapter: truth.chapter,
      wordCount: truth.wordCount,
      tokenCount: truth.tokenCount,
      charLength: truth.charLength,
    }
  },
  validate: (content, run) => validateMetadata(content, run.source, truthOf(run)),
  fallback: (run) => truthOf(run),
  empty: { chapter: 1, wordCount: 0, tokenCount: 0, charLength: 0 },
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
    annotations: [
      tool('TL219', {
        name: 'metadata',
        description: 'Extracts and validates the schema-doc metadata row.',
        refs: [],
        meta: { alsoCovers: ['TL081'] },
      }),
      category(['extractor', 'llm']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      return runExtractor(SPEC, env, ctx, options ?? {}, {})
    },
  })
}

/** Metadata tool with the default prompts and model. */
export const metadataTool = createMetadataTool()
