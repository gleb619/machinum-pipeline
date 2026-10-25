import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { loadBundledPrompt } from '../../core/bundled-prompts.js'
import { splitSentences } from '../heuristic-summary.js'
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

/** Share of the chapter's key terms a summary must mention to count as covering the chapter. */
const MIN_TERM_COVERAGE = 0.15
const MIN_TERMS_FOR_COVERAGE = 5

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
  if (bodyWords >= 40 && countWords(content) > bodyWords) {
    return { ok: false, reason: 'the summary is longer than the chapter it summarises' }
  }

  return { ok: true, value: content }
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: SUMMARY_SYSTEM_PROMPT,
  userPrompt: SUMMARY_USER_PROMPT,
}

/**
 * Builds the LLM-backed summary tool.
 *
 * Options (`model`, `temperature`, `maxTokens`, `systemPrompt`, `userPrompt`,
 * `maxAttempts`, `routerUrl`) can also be overridden per envelope through
 * `meta.schemaDocLlm` or `meta.summaryPrompt` / `meta.summarySystemPrompt`.
 * When the loop guard is exhausted the schema-doc `## Summary` text is used, so a
 * missing or failing router never fails the run.
 */
export function createSummaryTool(options?: SchemaDocLlmOptions) {
  return defineTool<string, string>({
    name: 'summary',
    version: '1.1.0',
    mdDescription:
      'Summarises the chapter with an LLM through the OpenRouter proxy (configurable prompts, ' +
      'loop-guarded retries, deterministic schema-doc parse as fallback). Stores `meta.summary`.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...options }, env.meta, 'summary')
      const inputs = env.items ?? [env.item]

      const summaries: string[] = []
      const results: PromptRetryResult<string>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(
            resolved.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
            chapterVars(source),
          ),
          userPrompt: renderPrompt(resolved.userPrompt ?? SUMMARY_USER_PROMPT, chapterVars(source)),
          validate: (content) => validateSummary(content, source),
        })
        summaries.push(outcome.ok && outcome.value !== undefined ? outcome.value : source.body)
        results.push(outcome)
      }

      const meta: Envelope<string>['meta'] = {
        ...env.meta,
        summary: summaries[0] ?? '',
        summaryLlm: attemptMeta(results),
      }
      if (env.items) {
        meta.summaryByItem = summaries
      }
      return { ...env, meta }
    },
  })
}

/** Summary tool with the default prompts and model. */
export const summaryTool = createSummaryTool()

// ---------------------------------------------------------------------------
// Summary notes (bundled prompts)
// ---------------------------------------------------------------------------

/** Default number of `- ` notes the notes mode asks the model for. */
export const DEFAULT_NOTE_COUNT = 10

export interface NotesSummaryOptions extends SchemaDocLlmOptions {
  /** Number of summary notes to ask for (and to keep at most). Default: 10. */
  count?: number
}

/** The bullet-note prompts ported from machinum-llm `SummarySystem.ST` / `Summary.ST`. */
const NOTES_DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: loadBundledPrompt('summary.system'),
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
 * flowing paragraph, prompted with the bundled `summary.system` / `summary.user` prompts
 * (`packages/tools/prompts/*.md`, compiled into the package).
 *
 * Same option surface as `createSummaryTool` plus `count`; prompts stay overridable through
 * `meta.schemaDocLlm` or `meta.summaryNotesPrompt` / `meta.summaryNotesSystemPrompt`. When the
 * loop guard is exhausted the chapter's lead sentences are used, so a failing router never
 * fails the run. Writes `meta.summaryNotes` (dash stripped) and `meta.summary` (bullet block).
 */
export function createNotesSummaryTool(options?: NotesSummaryOptions) {
  const { count = DEFAULT_NOTE_COUNT, ...llmOptions } = options ?? {}
  const noteCount = Math.max(1, Math.floor(count))

  return defineTool<string, string>({
    name: 'summary-notes',
    version: '1.0.0',
    mdDescription:
      'Extracts `count` plain-text summary notes (`- ` bullets) from the chapter with an LLM ' +
      'through the OpenRouter proxy, using the bundled summary prompts. Loop-guarded retries ' +
      'fall back to the chapter lead sentences. Stores `meta.summaryNotes` and `meta.summary`.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const resolved = resolveLlmOptions(
        { ...NOTES_DEFAULTS, ...llmOptions },
        env.meta,
        'summaryNotes',
      )
      const inputs = env.items ?? [env.item]

      const notesByItem: string[][] = []
      const results: PromptRetryResult<string[]>[] = []

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
        const vars = chapterVars(source, { count: noteCount, text: source.body })
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(
            resolved.systemPrompt ?? NOTES_DEFAULTS.systemPrompt ?? '',
            vars,
          ),
          userPrompt: renderPrompt(resolved.userPrompt ?? NOTES_DEFAULTS.userPrompt ?? '', vars),
          validate: validateNotes,
        })
        const notes =
          outcome.ok && outcome.value ? outcome.value : heuristicNotes(source.body, noteCount)
        notesByItem.push(notes.slice(0, noteCount))
        results.push(outcome)
      }

      const notes = notesByItem[0] ?? []
      const meta: Envelope<string>['meta'] = {
        ...env.meta,
        summaryNotes: notes,
        summaryNotesLlm: attemptMeta(results),
      }
      if (notes.length > 0) {
        meta.summary = renderSummaryNotes(notes)
      }
      if (env.items) {
        meta.summaryNotesByItem = notesByItem
      }
      return { ...env, meta }
    },
  })
}

/** Summary notes tool with the bundled prompts and default note count. */
export const notesSummaryTool = createNotesSummaryTool()
