import { setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import {
  type ChunkBudget,
  type ChunkModeOptions,
  type ChunkRecord,
  resolvePromptBudget,
  runChunkedText,
  toChunkRecord,
} from '../../core/chunk-processor.js'
import { chapterVars, readChapter, renderPrompt } from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

/** One extraction step: the chapter the LLM works on plus the envelope it came from. */
export interface ExtractorRun<S = undefined> {
  /** The envelope being processed. */
  env: Exchange<string>
  ctx: ToolContext
  /** The chapter - or the chunk of it - the call works on. */
  source: ChapterSource
  /** The raw item text. */
  item: string
  /** Per-invoke state of the tool (e.g. the vocabulary known-word set). */
  state: S
}

/**
 * What one schema extraction tool declares. The driver owns the shared skeleton:
 * option resolution, the item loop, the chunk dispatch and the published variables.
 */
export interface ExtractorSpec<T, S = undefined> {
  /** Variable prefix: `<key>`, `<key>Llm`, `<key>ByItem`, `<key>Chunks`. */
  key: string
  /** Default prompts and model options, resolved per invoke. */
  defaults: () => SchemaDocLlmOptions
  /** Accepts one LLM answer, or explains why it is rejected. */
  validate: (content: string, run: ExtractorRun<S>) => PromptValidation<T>
  /** The value used when a call fails. */
  fallback: (run: ExtractorRun<S>) => T
  /** The value a failed chunk contributes (defaults to `fallback`). */
  partFallback?: (run: ExtractorRun<S>) => T
  /** Narrows an accepted LLM answer before it is merged (defaults to the identity). */
  transform?: (value: T, run: ExtractorRun<S>) => T
  /** Extra `{{var}}` values of the prompts. */
  vars?: (run: ExtractorRun<S>) => Record<string, string | number>
  /** The prompt parts measured for the budget (defaults to the rendered prompts). */
  budgetPrompts?: (run: ExtractorRun<S>, resolved: SchemaDocLlmOptions) => readonly string[]
  /** Output reserve used when neither the options nor the model ask for one. */
  defaultOutputReserve?: number
  /** Merges the per-chunk values; presence enables the chunk modes. */
  merge?: (values: readonly T[], run: ExtractorRun<S>) => T
  /** Records the chunk outcomes in chunk order instead of completion order. */
  orderedChunkOutcomes?: boolean
  /** Post-processes the value of one item (defaults to the identity). */
  postProcess?: (value: T, run: ExtractorRun<S>) => T
  /** Variables published next to the standard ones. */
  extraVariables?: (
    values: readonly T[],
    env: Exchange<string>,
    state: S,
  ) => Record<string, unknown>
  /** Per-invoke state shared by the hooks. */
  createState?: (env: Exchange<string>) => S
  /** Chunk concurrency (defaults to the shared chunk-processor default). */
  concurrency?: (env: Exchange<string>, ctx: ToolContext) => number | undefined
  /** The value published when the envelope carries no item. */
  empty: T
  /** The value published for an item that is not a readable chapter; unset = fail. */
  tolerateUnreadable?: T
}

function unreadableReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `the chapter cannot be parsed as a schema-doc: ${message}`
}

/**
 * Runs one schema extraction tool and publishes its variables: resolves the LLM options,
 * walks the items of the envelope, calls the LLM (single or chunked) and stores
 * `<key>`, `<key>Llm`, `<key>ByItem` and `<key>Chunks`.
 *
 * The tool supplies its prompts, validator, fallbacks and merge strategy; everything
 * else - the option precedence, the chunk dispatch and the attempt bookkeeping - is
 * the same for every extraction tool and lives here.
 */
export async function runExtractor<T, S = undefined>(
  spec: ExtractorSpec<T, S>,
  env: Exchange<string>,
  ctx: ToolContext,
  llm: SchemaDocLlmOptions,
  chunk: ChunkModeOptions,
): Promise<Exchange<string>> {
  const base = spec.defaults()
  const resolved = resolveLlmOptions({ ...base, ...llm }, env, spec.key)
  const systemPrompt = resolved.systemPrompt ?? base.systemPrompt ?? ''
  const userPrompt = resolved.userPrompt ?? base.userPrompt ?? ''
  const state = (spec.createState?.(env) ?? undefined) as S
  const inputs = env.items ?? [env.item]

  const values: T[] = []
  const results: PromptRetryResult<T>[] = []
  const chunks: ChunkRecord[] = []

  for (const input of inputs) {
    let source: ChapterSource
    try {
      source = readChapter(input)
    } catch (error) {
      if (spec.tolerateUnreadable === undefined) throw error
      const reason = unreadableReason(error)
      values.push(spec.tolerateUnreadable)
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

    const run = (part: ChapterSource): ExtractorRun<S> => ({
      env,
      ctx,
      source: part,
      item: input,
      state,
    })

    const pending: { index: number | undefined; outcome: PromptRetryResult<T> }[] = []
    const runOnce = async (part: ChapterSource, index?: number): Promise<T> => {
      const partRun = run(part)
      const vars = { ...chapterVars(part), ...(spec.vars?.(partRun) ?? {}) }
      const outcome = await runPromptWithRetry<T>(ctx, {
        ...resolved,
        systemPrompt: renderPrompt(systemPrompt, vars),
        userPrompt: renderPrompt(userPrompt, vars),
        validate: (content) => spec.validate(content, partRun),
      })
      pending.push({ index, outcome })
      if (outcome.ok && outcome.value !== undefined) {
        return spec.transform ? spec.transform(outcome.value, partRun) : outcome.value
      }
      return (spec.partFallback ?? spec.fallback)(partRun)
    }

    const budget = (): ChunkBudget | null => {
      const parts = spec.budgetPrompts
        ? spec.budgetPrompts(run(source), resolved)
        : budgetPrompts(spec, run(source), systemPrompt, userPrompt)
      return resolvePromptBudget(ctx, resolved, chunk, parts, spec.defaultOutputReserve)
    }

    const chunked = await runChunkedText<T>({
      mode: chunk.chunkMode,
      text: source.body,
      budget,
      single: () => runOnce(source),
      chunk: (chunkText, index) => runOnce({ ...source, body: chunkText }, index),
      merge: (parts) => (spec.merge ? spec.merge(parts, run(source)) : (parts[0] ?? spec.empty)),
      splitUnit: chunk.splitUnit,
      // The explicit option wins; the tuned fallback is resolved only on the chunked path.
      concurrency:
        chunk.chunkConcurrency ??
        (spec.concurrency ? () => spec.concurrency?.(env, ctx) : undefined),
    })
    if (chunked.budget) chunks.push(toChunkRecord(chunked.budget, chunked.chunks))

    const chunkOutcomes = pending.filter((entry) => entry.index !== undefined)
    results.push(
      ...pending.filter((entry) => entry.index === undefined).map((entry) => entry.outcome),
      ...(spec.orderedChunkOutcomes
        ? [...chunkOutcomes].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        : chunkOutcomes
      ).map((entry) => entry.outcome),
    )

    values.push(spec.postProcess ? spec.postProcess(chunked.value, run(source)) : chunked.value)
  }

  return publish(spec, env, values, results, chunks, state)
}

/** Publishes the standard variables of an extraction tool. */
function publish<T, S>(
  spec: ExtractorSpec<T, S>,
  env: Exchange<string>,
  values: T[],
  results: PromptRetryResult<T>[],
  chunks: ChunkRecord[],
  state: S,
): Exchange<string> {
  const published: Record<string, unknown> = {
    [spec.key]: values[0] ?? spec.empty,
    [`${spec.key}Llm`]: attemptMeta(results),
    ...(spec.extraVariables?.(values, env, state) ?? {}),
  }
  if (env.items) {
    published[`${spec.key}ByItem`] = values
  }
  if (chunks.length > 0) {
    published[`${spec.key}Chunks`] = chunks
  }
  return setVariables(env, published)
}

/** The rendered prompts with an empty body: what the budget measures. */
function budgetPrompts<T, S>(
  spec: ExtractorSpec<T, S>,
  run: ExtractorRun<S>,
  systemPrompt: string,
  userPrompt: string,
): readonly string[] {
  const vars = { ...chapterVars(run.source), ...(spec.vars?.(run) ?? {}), body: '' }
  return [renderPrompt(systemPrompt, vars), renderPrompt(userPrompt, vars)]
}
