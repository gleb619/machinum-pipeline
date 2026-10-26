import { getDefaultPrompt, renderTemplate } from './llm-prompts.js'

// ---------------------------------------------------------------------------
// Work modes (shared by every LLM tool family: translation, summary, proofread, …)
// ---------------------------------------------------------------------------

/**
 * Work mode of an LLM prompt unit:
 * - `plain` — raw text, 1 line/paragraph in → 1 line/paragraph out (default, backward compatible).
 * - `xml` — input lines wrapped as `<result><id>N</id><origin>…</origin></result>`, the model
 *   replies with `<result><id>N</id><translated>…</translated></result>` blocks.
 * - `properties` — input lines wrapped as `N=text`, the model replies with `N=value` lines.
 */
export type PromptWorkMode = 'plain' | 'xml' | 'properties'

export const PROMPT_WORK_MODES: readonly PromptWorkMode[] = ['plain', 'xml', 'properties']

/** Wraps the unit text per work mode for the user prompt. Shared by all prompt families. */
export function wrapPromptInput(text: string, mode: PromptWorkMode): string {
  if (mode === 'xml') {
    const body = text
      .split('\n')
      .map((line, i) => `<result><id>${i + 1}</id><origin>${line}</origin></result>`)
      .join('\n')
    return `<context>\n${body}\n</context>`
  }
  if (mode === 'properties') {
    const body = text
      .split('\n')
      .map((line, i) => `${i + 1}=${line}`)
      .join('\n')
    return `<context>\n${body}\n</context>`
  }
  // `plain` stays unwrapped: the reply is expected to mirror the unit with no framing, so any
  // wrapper would leak into the output (and break reply echo mocks).
  return text
}

// ---------------------------------------------------------------------------
// Structured reply parsing (xml / properties), shared by translation + proofread
// ---------------------------------------------------------------------------

/** Structured reply kinds with a tolerant extraction + contiguous 1..N contract. */
export type StructuredReplyMode = 'xml' | 'properties'

/** One extracted `key=value` pair of a structured reply (`key` = 1-based line/id number). */
export interface StructuredReplyEntry {
  key: number
  /** Raw extracted value (untrimmed; callers trim/unescape as their format demands). */
  value: string
}

/** Thrown when a structured reply cannot be parsed; `retryable` so the engine retries. */
export class StructuredReplyParseError extends Error {
  readonly retryable = true
  constructor(
    readonly mode: StructuredReplyMode,
    /** The plain message, without the `mode reply parse error:` prefix. */
    readonly detail: string,
  ) {
    super(`${mode} reply parse error: ${detail}`)
    this.name = 'StructuredReplyParseError'
  }
}

const XML_RESULT_BLOCK_RE = /<result>([\s\S]*?)<\/result>/g
const XML_ID_RE = /<id>\s*(\d+)\s*<\/id>/
const PROPERTIES_LINE_RE = /^(\d+)\s*=(.*)$/

/** Removes reasoning blocks, XML declarations and code fences around a model reply. */
function stripReplyNoise(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\?xml[^?]*\?>/, '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
}

/**
 * Extracts `<result>` blocks of any shape tolerantly (no XML dependency): for every
 * `<result>…</result>` block containing an `<id>N</id>` and a `<valueTag>…</valueTag>` child,
 * one entry is returned (in document order, values untrimmed). Blocks missing either child are
 * skipped. `valueTag` defaults to `translated` (translation contract); proofread passes `text` /
 * `proofread`.
 */
export function extractXmlResultEntries(
  reply: string,
  valueTag = 'translated',
): StructuredReplyEntry[] {
  const content = stripReplyNoise(reply)
  const tagRe = new RegExp(`<${valueTag}>([\\s\\S]*?)</${valueTag}>`, 's')
  const out: StructuredReplyEntry[] = []
  for (const m of content.matchAll(XML_RESULT_BLOCK_RE)) {
    const block = m[1] ?? ''
    const id = XML_ID_RE.exec(block)
    const value = tagRe.exec(block)
    if (!id || !value) continue
    out.push({ key: Number(id[1]), value: value[1] ?? '' })
  }
  return out
}

export interface PropertiesExtractionOptions {
  /**
   * Unescape Java-properties value escapes (`\n`, `\=`, `\\`) — used by the proofread
   * properties format. Translation values are plain text and stay untouched.
   */
  unescape?: boolean
}

function unescapePropertiesValue(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\=/g, '=').replace(/\\\\/g, '\\')
}

/**
 * Extracts `N=value` lines tolerantly: every line of the form `N=value` (N = 1-based line
 * number) yields one entry, in document order, with the raw (untrimmed) value. Blank lines,
 * comments and non-matching prose are skipped.
 */
export function extractPropertiesEntries(
  reply: string,
  opts: PropertiesExtractionOptions = {},
): StructuredReplyEntry[] {
  const out: StructuredReplyEntry[] = []
  for (const raw of stripReplyNoise(reply).split('\n')) {
    const m = PROPERTIES_LINE_RE.exec(raw.trim())
    if (!m) continue
    const value = m[2] ?? ''
    out.push({
      key: Number(m[1] ?? ''),
      value: opts.unescape === true ? unescapePropertiesValue(value) : value,
    })
  }
  return out
}

/**
 * Parses a structured model reply (`xml` / `properties`): tolerant extraction, numeric sort,
 * and a strict contiguity check — keys must be exactly 1..maxKey (no gaps, no duplicates).
 * Throws a retryable {@link StructuredReplyParseError} otherwise. (The expected total N is
 * enforced downstream by the caller's own line-parity / id checks.)
 */
export function parseStructuredReply(
  reply: string,
  mode: StructuredReplyMode,
  opts: PropertiesExtractionOptions & { valueTag?: string } = {},
): string[] {
  const entries =
    mode === 'xml'
      ? extractXmlResultEntries(reply, opts.valueTag)
      : extractPropertiesEntries(reply, opts)
  if (entries.length === 0) {
    throw new StructuredReplyParseError(
      mode,
      'no result blocks / key=value lines found in the reply',
    )
  }
  const byKey = new Map<number, string>()
  for (const e of entries) {
    if (byKey.has(e.key)) {
      throw new StructuredReplyParseError(mode, `duplicate id/key ${e.key}`)
    }
    byKey.set(e.key, e.value.trim())
  }
  const maxKey = Math.max(...byKey.keys())
  const lines: string[] = []
  for (let i = 1; i <= maxKey; i++) {
    const value = byKey.get(i)
    if (value === undefined) {
      throw new StructuredReplyParseError(
        mode,
        `missing id/key ${i} (got ${byKey.size} block(s)/line(s), keys must be contiguous 1..N)`,
      )
    }
    lines.push(value)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Prompt block composition (<family>.system + llm.format.<mode> + <family>.output[.<mode>])
// ---------------------------------------------------------------------------

/** Result of {@link composePromptBlocks}. */
export interface PromptBlockComposition {
  /**
   * The present blocks joined blank-line separated. When `complete` is `false` this holds only
   * the blocks that rendered (callers typically discard it and fall back to a hand-built prompt).
   */
  systemPrompt: string
  /** The unit text wrapped per mode ({@link wrapPromptInput}). */
  userPrompt: string
  /**
   * `false` when a required block template (`<family>.system`, `llm.format.<mode>` or an output
   * block) is missing or renders empty — callers then fall back to a hand-built prompt, mirroring
   * the original `buildTranslationPrompt` philosophy.
   */
  complete: boolean
}

function renderBlock(name: string, vars: Record<string, string>): string | undefined {
  const template = getDefaultPrompt(name)?.template
  if (template === undefined) return undefined
  return renderTemplate(template, vars, name).trim()
}

/**
 * Composes the system + user prompt for an LLM tool family from the global + family prompt
 * blocks (registered prompt-registry defaults, overridable via `meta.prompts` / mt.json /
 * `MT_PROMPT_<NAME>` like any other prompt):
 *
 * - `<family>.system` — the tool-specific system block
 * - `llm.format.<mode>` — the global input-format block (shared by all families)
 * - `<family>.output.<mode>` — the tool-specific output contract; falls back to the single
 *   `<family>.output` block when the mode-specific one is missing
 *
 * Every present block is rendered with the full `vars` set, so a block only needs the vars it
 * actually uses. The user prompt is the input text wrapped per mode.
 */
export interface ComposePromptBlocksOptions {
  /**
   * Explicit output-block name (e.g. `'summary.output.bullets'`) instead of the default
   * `<family>.output.<mode>` (with `<family>.output` fallback). Use it when the family's output
   * contract is a named style rather than one block per work mode.
   */
  output?: string
}

export function composePromptBlocks(
  family: string,
  mode: PromptWorkMode,
  vars: Record<string, string> = {},
  opts: ComposePromptBlocksOptions = {},
): PromptBlockComposition {
  const systemPart = renderBlock(`${family}.system`, vars)
  const formatPart = renderBlock(`llm.format.${mode}`, vars)
  const outputPart =
    opts.output !== undefined
      ? renderBlock(opts.output, vars)
      : (renderBlock(`${family}.output.${mode}`, vars) ??
        (mode === 'plain' ? undefined : renderBlock(`${family}.output`, vars)))
  const parts = [systemPart, formatPart, outputPart]
  const complete = parts.every((p) => p !== undefined && p !== '')
  return {
    systemPrompt: parts.filter((p): p is string => p !== undefined && p !== '').join('\n\n'),
    userPrompt: wrapPromptInput(vars.text ?? '', mode),
    complete,
  }
}

export interface BuildLlmPromptInput {
  /** The unit text to process. */
  text: string
  /** Work mode. Default `'plain'`. */
  mode?: PromptWorkMode
  /** Extra `{{var}}` values the family blocks may use. */
  vars?: Record<string, string>
}

/** Convenience: {@link composePromptBlocks} with the text folded into the var set. */
export function buildLlmPrompt(family: string, input: BuildLlmPromptInput): PromptBlockComposition {
  return composePromptBlocks(family, input.mode ?? 'plain', { ...input.vars, text: input.text })
}
