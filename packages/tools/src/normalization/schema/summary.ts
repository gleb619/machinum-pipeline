import { defineTool, setVariables, tool } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import {
  DEFAULT_CHUNK_CONCURRENCY,
  DEFAULT_NOTE_COUNT,
  MIN_TERMS_FOR_COVERAGE,
  MIN_TERM_COVERAGE,
  SUMMARY_MIN_BODY_WORDS,
  SUMMARY_OUTPUT_RESERVE,
} from '../../constants.js'
import { loadBundledPrompt } from '../../core/bundled-prompts.js'
import {
  type ChunkBudget,
  type SemanticUnit,
  adaptiveSemanticChunks,
  estimateOverhead,
  processChunks,
  resolveChunkBudget,
  shouldChunkText,
} from '../../core/chunk-processor.js'
import { composePromptBlocks } from '../../core/prompt-blocks.js'
import { resolveTunedNum } from '../../resolve-constants.js'
import { splitSentences } from '../heuristic-summary.js'
import { countTextTokens } from '../token-counter.js'
import {
  chapterVars,
  countWords,
  frequentTerms,
  readChapter,
  renderPrompt,
  roundTripIssue,
  stripCodeFence,
} from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const SUMMARY_SYSTEM_PROMPT =
  'You are a technical editor. Summarise the chapter you are given as one flowing paragraph of ' +
  '3 to 6 sentences. Reply with the summary text only: no headings, no bullet lists, no markdown ' +
  'sections, no preamble.'

export const SUMMARY_USER_PROMPT = 'Summarise this chapter.\n\n# {{title}}\n\n{{body}}'

/**
 * Default system prompt of the summary family: the bundled `summary.system` block + the global
 * `llm.format.plain` input block + the `summary.output.bullets` output contract (see
 * `packages/tools/prompts/*.md`). Falls back to the legacy inline {@link SUMMARY_SYSTEM_PROMPT}
 * when a block template is missing.
 */
export function defaultSummarySystemPrompt(): string {
  const composed = composePromptBlocks('summary', 'plain', {}, { output: 'summary.output.bullets' })
  return composed.complete ? composed.systemPrompt : SUMMARY_SYSTEM_PROMPT
}

export { DEFAULT_NOTE_COUNT, MIN_TERM_COVERAGE, MIN_TERMS_FOR_COVERAGE }

function validateSummary(content: string, source: ChapterSource): PromptValidation<string> {
  const parseIssue = roundTripIssue(
    { ...source.doc, summary: content },
    (doc) => doc.summary,
    'summary',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  const terms = frequentTerms(source.body)
  if (terms.length >= MIN_TERMS_FOR_COVERAGE) {
    const lowered = content.toLowerCase()
    const missing = terms.filter((term) => !lowered.includes(term))
    const required = Math.ceil(terms.length * MIN_TERM_COVERAGE)
    if (missing.length > terms.length - required) {
      return {
        ok: false,
        reason:
          `the summary omits ${missing.length} of ${terms.length} key chapter terms - you forgot: ` +
          `${missing.slice(0, 8).join(', ')}`,
      }
    }
  }

  const bodyWords = countWords(source.body)
  if (bodyWords >= SUMMARY_MIN_BODY_WORDS && countWords(content) > bodyWords) {
    return { ok: false, reason: 'the summary is longer than the chapter it summarises' }
  }

  return { ok: true, value: content }
}

const DEFAULTS: SchemaDocLlmOptions = {
  userPrompt: SUMMARY_USER_PROMPT,
}

// ---------------------------------------------------------------------------
// Chunk budget for summaries
// ---------------------------------------------------------------------------

export type SummaryChunkMode = 'shrink' | 'chunk' | 'auto'

export interface SummaryChunkOptions {
  /** How to handle text larger than the model budget. Default 'shrink' (existing behaviour). */
  chunkMode?: SummaryChunkMode
  /** Per-call output token reserve. */
  outputReserve?: number
  /** Safety reserve tokens. */
  reserve?: number
  /** Preferred semantic split unit. */
  splitUnit?: SemanticUnit
  /** Chunk processing concurrency. */
  chunkConcurrency?: number
}

function summaryBudget(
  resolved: SchemaDocLlmOptions,
  source: ChapterSource,
  options: Pick<SummaryChunkOptions, 'outputReserve' | 'reserve'>,
  ctx: ToolContext,
): ChunkBudget | null {
  const system = resolved.systemPrompt ?? defaultSummarySystemPrompt()
  const titleOnlyUser = renderPrompt(resolved.userPrompt ?? SUMMARY_USER_PROMPT, {
    ...chapterVars(source),
    body: '',
  })
  const overhead = estimateOverhead(system, titleOnlyUser)
  return resolveChunkBudget({
    ctx,
    input: {
      model: resolved.model,
      outputReserve: options.outputReserve ?? resolved.maxTokens ?? SUMMARY_OUTPUT_RESERVE,
      overhead,
      reserve: options.reserve,
    },
    llmConfig: resolved,
  })
}

async function runSingleSummary(
  ctx: ToolContext,
  source: ChapterSource,
  resolved: SchemaDocLlmOptions,
): Promise<PromptRetryResult<string>> {
  const vars = chapterVars(source)
  return runPromptWithRetry(ctx, {
    ...resolved,
    systemPrompt: renderPrompt(resolved.systemPrompt ?? defaultSummarySystemPrompt(), vars),
    userPrompt: renderPrompt(resolved.userPrompt ?? SUMMARY_USER_PROMPT, vars),
    validate: (content) => validateSummary(content, source),
  })
}

function mergeSummaries(summaries: readonly string[]): string {
  return summaries.join('\n\n')
}

async function runChunkedSummary(
  ctx: ToolContext,
  source: ChapterSource,
  resolved: SchemaDocLlmOptions,
  budget: ChunkBudget,
  options: Pick<SummaryChunkOptions, 'splitUnit' | 'chunkConcurrency'>,
  env: Exchange<unknown>,
): Promise<{ summary: string; chunks: number; outcomes: PromptRetryResult<string>[] }> {
  const chunks = adaptiveSemanticChunks(source.body, budget, {
    unit: options.splitUnit ?? 'paragraph',
    count: countTextTokens,
  })
  const outcomes: PromptRetryResult<string>[] = new Array(chunks.length)
  const summary = await processChunks({
    chunks,
    process: async (chunk, index) => {
      const chunkSource: ChapterSource = { ...source, body: chunk }
      const outcome = await runSingleSummary(ctx, chunkSource, resolved)
      outcomes[index] = outcome
      return outcome.ok && outcome.value !== undefined ? outcome.value : chunk
    },
    merge: mergeSummaries,
    concurrency:
      options.chunkConcurrency ??
      resolveTunedNum('DEFAULT_CHUNK_CONCURRENCY', DEFAULT_CHUNK_CONCURRENCY, env, ctx),
  })
  return { summary, chunks: chunks.length, outcomes: outcomes.filter(Boolean) }
}

/**
 * Builds the LLM-backed summary tool.
 *
 * Options (`model`, `temperature`, `maxTokens`, `systemPrompt`, `userPrompt`,
 * `maxAttempts`, `routerUrl`) can also be overridden per envelope through
 * variable `schemaDocLlm` or variables `summaryPrompt` / `summarySystemPrompt`.
 * When the loop guard is exhausted the schema-doc `## Summary` text is used, so a
 * missing or failing router never fails the run.
 */
export function createSummaryTool(options?: SchemaDocLlmOptions & SummaryChunkOptions) {
  const {
    chunkMode = 'shrink',
    outputReserve,
    reserve,
    splitUnit,
    chunkConcurrency,
    ...llmOptions
  } = options ?? {}

  return defineTool<string, string>({
    name: 'summary',
    version: '1.2.0',
    mdDescription:
      'Summarises the chapter with an LLM through the OpenRouter proxy (configurable prompts, ' +
      'loop-guarded retries, deterministic schema-doc parse as fallback). The default system ' +
      'prompt is composed from the bundled summary.* blocks (plain input + bullet-list output). ' +
      'Supports shrink/chunk/auto modes. Stores variable `summary`.',
    annotations: [
      tool('TL034', {
        name: 'summary',
        description: 'Summarizes a chapter with loop-guarded LLM retries.',
        refs: [],
      }),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...llmOptions }, env, 'summary')
      const inputs = env.items ?? [env.item]

      const summaries: string[] = []
      const results: PromptRetryResult<string>[] = []
      const chunkRecords: Array<{ chunks: number; budget: ChunkBudget }> = []

      for (const input of inputs) {
        const source = readChapter(input)
        let summary: string
        let outcome: PromptRetryResult<string> | undefined

        if (chunkMode === 'shrink') {
          outcome = await runSingleSummary(ctx, source, resolved)
          summary = outcome.ok && outcome.value !== undefined ? outcome.value : source.body
        } else {
          const budget = summaryBudget(resolved, source, { outputReserve, reserve }, ctx)
          if (!budget || (chunkMode === 'auto' && !shouldChunkText(source.body, budget))) {
            outcome = await runSingleSummary(ctx, source, resolved)
            summary = outcome.ok && outcome.value !== undefined ? outcome.value : source.body
          } else {
            const chunked = await runChunkedSummary(
              ctx,
              source,
              resolved,
              budget,
              {
                splitUnit,
                chunkConcurrency,
              },
              env,
            )
            summary = chunked.summary
            results.push(...chunked.outcomes)
            chunkRecords.push({ chunks: chunked.chunks, budget })
          }
        }
        if (outcome) results.push(outcome)
        summaries.push(summary)
      }

      const values: Record<string, unknown> = {
        summary: summaries[0] ?? '',
        summaryLlm: attemptMeta(results),
      }
      if (env.items) {
        values.summaryByItem = summaries
      }
      if (chunkRecords.length > 0) {
        values.summaryChunks = chunkRecords.map((r) => ({
          chunks: r.chunks,
          limit: r.budget.limit,
          inputBudget: r.budget.inputBudget,
          model: r.budget.model,
        }))
      }
      return setVariables(env, values)
    },
  })
}

/** Summary tool with the default prompts and model. */
export const summaryTool = createSummaryTool()

// ---------------------------------------------------------------------------
// Summary notes (bundled prompts)
// ---------------------------------------------------------------------------

export interface NotesSummaryOptions extends SchemaDocLlmOptions {
  /** Number of summary notes to ask for (and to keep at most). Default: 10. */
  count?: number
}

/** The bullet-note prompts ported from machinum-llm `SummarySystem.ST` / `Summary.ST`. */
const NOTES_DEFAULTS: SchemaDocLlmOptions = {
  userPrompt: loadBundledPrompt('summary.user'),
}

const NOTE_LINE = /^-\s+\S/

/**
 * Strict notes validator: the answer may be fenced, but every non-empty line inside it must
 * be a `- ` bullet. Fewer notes than requested are accepted - a short chapter has fewer facts.
 */
function validateNotes(content: string): PromptValidation<string[]> {
  const lines = stripCodeFence(content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) {
    return { ok: false, reason: 'the answer contains no `- ` summary notes' }
  }
  const offending = lines.find((line) => !NOTE_LINE.test(line))
  if (offending !== undefined) {
    return {
      ok: false,
      reason: `every line must be a '- ' bullet, got: ${offending.slice(0, 60)}`,
    }
  }
  return { ok: true, value: lines.map((line) => line.slice(1).trim()) }
}

/** Offline fallback: the lead sentences of the chapter, one note each. */
function heuristicNotes(body: string, count: number): string[] {
  return splitSentences(body)
    .slice(0, count)
    .map((sentence) => sentence.replace(/\s+/g, ' '))
}

/** Renders notes back into the plain-text bullet block the prompts demand. */
export function renderSummaryNotes(notes: string[]): string {
  return notes.map((note) => `- ${note}`).join('\n')
}

/**
 * Builds the LLM-backed "summary notes" tool: `count` plain-text `- ` notes instead of one
 * flowing paragraph. The system prompt is composed from the bundled `summary.system`, the global
 * `llm.format.plain` and the `summary.output.bullets` blocks; the user prompt is the bundled
 * `summary.user` (`packages/tools/prompts/*.md`, compiled into the package).
 *
 * Same option surface as `createSummaryTool` plus `count`; prompts stay overridable through
 * variable `schemaDocLlm` or variables `summaryNotesPrompt` / `summaryNotesSystemPrompt`. When the
 * loop guard is exhausted the chapter's lead sentences are used, so a failing router never
 * fails the run. Writes variables `summaryNotes` (dash stripped) and `summary` (bullet block).
 */
export function createNotesSummaryTool(options?: NotesSummaryOptions & SummaryChunkOptions) {
  const {
    count = DEFAULT_NOTE_COUNT,
    chunkMode = 'shrink',
    outputReserve,
    reserve,
    splitUnit,
    chunkConcurrency,
    ...llmOptions
  } = options ?? {}
  const noteCount = Math.max(1, Math.floor(count))

  return defineTool<string, string>({
    name: 'summary-notes',
    version: '1.1.0',
    mdDescription:
      'Extracts `count` plain-text summary notes (`- ` bullets) from the chapter with an LLM ' +
      'through the OpenRouter proxy. The system prompt is composed from the bundled summary.* ' +
      'blocks (plain input + bullet-list output); the user prompt is the bundled `summary.user`. ' +
      'Loop-guarded retries fall back to the chapter lead sentences. Supports chunk modes. Stores ' +
      'variables `summaryNotes` and `summary`.',
    annotations: [
      tool('TL221', {
        name: 'summary-notes',
        description: 'Extracts bullet summary notes with loop-guarded LLM retries.',
        refs: [],
        meta: { alsoCovers: ['TL034'] },
      }),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const resolved = resolveLlmOptions({ ...NOTES_DEFAULTS, ...llmOptions }, env, 'summaryNotes')
      const inputs = env.items ?? [env.item]

      const notesByItem: string[][] = []
      const results: PromptRetryResult<string[]>[] = []
      const chunkRecords: Array<{ chunks: number; budget: ChunkBudget }> = []

      for (const input of inputs) {
        let source: ChapterSource
        try {
          source = readChapter(input)
        } catch (error) {
          // Not a readable schema-doc chapter: keep the run alive with empty notes.
          const reason = `the chapter cannot be parsed as a schema-doc: ${error instanceof Error ? error.message : String(error)}`
          notesByItem.push([])
          results.push({
            ok: false,
            content: '',
            attempts: 0,
            failures: [reason],
            lastFailure: reason,
            tokens: 0,
          })
          continue
        }
        let notes: string[]
        let outcome: PromptRetryResult<string[]> | undefined
        const chunkOutcomes: PromptRetryResult<string[]>[] = []
        if (chunkMode === 'shrink') {
          const once = await runNotesOnce(ctx, source, resolved, noteCount)
          notes = once.notes
          outcome = once.outcome
        } else {
          const budget = summaryBudget(resolved, source, { outputReserve, reserve }, ctx)
          if (!budget || (chunkMode === 'auto' && !shouldChunkText(source.body, budget))) {
            const once = await runNotesOnce(ctx, source, resolved, noteCount)
            notes = once.notes
            outcome = once.outcome
          } else {
            const chunks = adaptiveSemanticChunks(source.body, budget, {
              unit: splitUnit ?? 'paragraph',
              count: countTextTokens,
            })
            notes = await processChunks({
              chunks,
              process: async (chunk) => {
                const chunkSource: ChapterSource = { ...source, body: chunk }
                const once = await runNotesOnce(ctx, chunkSource, resolved, noteCount)
                chunkOutcomes.push(once.outcome)
                return once.notes
              },
              merge: (outs) => mergeNotes(outs, noteCount),
              concurrency:
                chunkConcurrency ??
                resolveTunedNum('DEFAULT_CHUNK_CONCURRENCY', DEFAULT_CHUNK_CONCURRENCY, env, ctx),
            })
            chunkRecords.push({ chunks: chunks.length, budget })
          }
        }

        if (outcome) results.push(outcome)
        results.push(...chunkOutcomes)
        notesByItem.push(notes.slice(0, noteCount))
      }

      const notes = notesByItem[0] ?? []
      const values: Record<string, unknown> = {
        summaryNotes: notes,
        summaryNotesLlm: attemptMeta(results),
      }
      if (notes.length > 0) {
        values.summary = renderSummaryNotes(notes)
      }
      if (env.items) {
        values.summaryNotesByItem = notesByItem
      }
      if (chunkRecords.length > 0) {
        values.summaryNotesChunks = chunkRecords.map((r) => ({
          chunks: r.chunks,
          limit: r.budget.limit,
          inputBudget: r.budget.inputBudget,
          model: r.budget.model,
        }))
      }
      return setVariables(env, values)
    },
  })
}

async function runNotesOnce(
  ctx: ToolContext,
  source: ChapterSource,
  resolved: SchemaDocLlmOptions,
  targetCount: number,
): Promise<{ notes: string[]; outcome: PromptRetryResult<string[]> }> {
  const vars = chapterVars(source, { count: targetCount, text: source.body })
  const outcome = await runPromptWithRetry(ctx, {
    ...resolved,
    systemPrompt: renderPrompt(resolved.systemPrompt ?? defaultSummarySystemPrompt(), vars),
    userPrompt: renderPrompt(resolved.userPrompt ?? NOTES_DEFAULTS.userPrompt ?? '', vars),
    validate: validateNotes,
  })
  const notes =
    outcome.ok && outcome.value ? outcome.value : heuristicNotes(source.body, targetCount)
  return { notes, outcome }
}

function mergeNotes(noteLists: readonly string[][], targetCount: number): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of noteLists) {
    for (const note of list) {
      const key = note.toLowerCase().replace(/\s+/g, ' ').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(note)
    }
  }
  return merged.slice(0, targetCount)
}

/** Summary notes tool with the bundled prompts and default note count. */
export const notesSummaryTool = createNotesSummaryTool()
