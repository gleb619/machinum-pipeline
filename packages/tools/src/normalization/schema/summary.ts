import { category, defineTool, tool } from '@mt/core'
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
import type { ChunkMode, ChunkModeOptions } from '../../core/chunk-processor.js'
import { composePromptBlocks } from '../../core/prompt-blocks.js'
import { resolveTunedNum } from '../../resolve-constants.js'
import { splitSentences } from '../heuristic-summary.js'
import {
  chapterVars,
  countWords,
  frequentTerms,
  renderPrompt,
  roundTripIssue,
  stripCodeFence,
} from './doc.js'
import type { ChapterSource } from './doc.js'
import { runExtractor } from './extractor.js'
import type { ExtractorRun, ExtractorSpec } from './extractor.js'
import type { PromptValidation, SchemaDocLlmOptions } from './llm.js'

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

/** How a summary tool treats text larger than the model budget. */
export type SummaryChunkMode = ChunkMode
/** The chunk options every summary tool accepts. */
export type SummaryChunkOptions = ChunkModeOptions

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

/**
 * The budget of the summary family: the system prompt as composed and the user prompt
 * without a body - the body is the text that gets chunked, not part of the overhead.
 */
function summaryBudgetPrompts<S>(
  run: ExtractorRun<S>,
  resolved: SchemaDocLlmOptions,
): readonly string[] {
  return [
    resolved.systemPrompt ?? defaultSummarySystemPrompt(),
    renderPrompt(resolved.userPrompt ?? SUMMARY_USER_PROMPT, {
      ...chapterVars(run.source),
      body: '',
    }),
  ]
}

/** The summary family shares the tuned chunk concurrency. */
function summaryConcurrency(env: Exchange<string>, ctx: ToolContext): number | undefined {
  return resolveTunedNum('DEFAULT_CHUNK_CONCURRENCY', DEFAULT_CHUNK_CONCURRENCY, env, ctx)
}

/**
 * The summary tool: one flowing paragraph per chapter. The chunk modes split the body and
 * join the per-chunk summaries; the loop guard falls back to the chapter body.
 */
const SUMMARY_SPEC: ExtractorSpec<string> = {
  key: 'summary',
  defaults: () => ({
    systemPrompt: defaultSummarySystemPrompt(),
    userPrompt: SUMMARY_USER_PROMPT,
  }),
  validate: (content, run) => validateSummary(content, run.source),
  fallback: (run) => run.source.body,
  merge: (values) => values.join('\n\n'),
  orderedChunkOutcomes: true,
  empty: '',
  defaultOutputReserve: SUMMARY_OUTPUT_RESERVE,
  budgetPrompts: summaryBudgetPrompts,
  concurrency: summaryConcurrency,
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
      category(['extractor', 'llm']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      return runExtractor(SUMMARY_SPEC, env, ctx, llmOptions, {
        chunkMode,
        outputReserve,
        reserve,
        splitUnit,
        chunkConcurrency,
      })
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

/** Per-invoke state: how many notes the tool asks for. */
interface NotesState {
  count: number
}

/** The notes tool: `count` plain-text `- ` notes instead of one flowing paragraph. */
function createNotesSpec(noteCount: number): ExtractorSpec<string[], NotesState> {
  return {
    key: 'summaryNotes',
    defaults: () => ({
      systemPrompt: defaultSummarySystemPrompt(),
      ...NOTES_DEFAULTS,
    }),
    createState: () => ({ count: noteCount }),
    vars: (run) => ({ count: run.state.count, text: run.source.body }),
    validate: (content) => validateNotes(content),
    fallback: (run) => heuristicNotes(run.source.body, run.state.count),
    merge: (values, run) => mergeNotes(values, run.state.count),
    postProcess: (value, run) => value.slice(0, run.state.count),
    extraVariables: (values) => {
      const notes = values[0] ?? []
      return notes.length > 0 ? { summary: renderSummaryNotes(notes) } : {}
    },
    empty: [],
    defaultOutputReserve: SUMMARY_OUTPUT_RESERVE,
    budgetPrompts: summaryBudgetPrompts,
    concurrency: summaryConcurrency,
    tolerateUnreadable: [],
  }
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
  const spec = createNotesSpec(noteCount)

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
      category(['extractor', 'llm']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      return runExtractor(spec, env, ctx, llmOptions, {
        chunkMode,
        outputReserve,
        reserve,
        splitUnit,
        chunkConcurrency,
      })
    },
  })
}

/** Summary notes tool with the bundled prompts and default note count. */
export const notesSummaryTool = createNotesSummaryTool()
