import { cleanTranslation } from './translation-prompt.js'
import type { TranslateWorkMode } from './translation-prompt.js'

/** Parsed model reply of a translation request. */
export interface ParsedTranslation {
  /** Translated lines in input order (line 1 first). */
  lines: string[]
  /** The `<plan>…</plan>` block of a `plan`-mode reply. */
  plan?: string
}

/** Thrown when a structured reply cannot be parsed; `retryable` so the engine retries. */
export class TranslationReplyParseError extends Error {
  readonly retryable = true
  constructor(
    readonly mode: TranslateWorkMode,
    message: string,
  ) {
    super(`${mode} reply parse error: ${message}`)
    this.name = 'TranslationReplyParseError'
  }
}

const PLAN_RE = /<plan>([\s\S]*?)<\/plan>/i
const XML_RESULT_RE =
  /<result>\s*<id>\s*(\d+)\s*<\/id>\s*<translated>([\s\S]*?)<\/translated>\s*<\/result>/gi
const PROPERTIES_LINE_RE = /^(\d+)\s*=(.*)$/

function stripThinkBlocks(reply: string): string {
  return reply.replace(/<think>[\s\S]*?<\/think>/gi, '')
}

/** Extracts `N=translation` lines: the key is the line number, the rest of the line is the value. */
function parseProperties(reply: string): Array<{ key: number; value: string }> {
  const out: Array<{ key: number; value: string }> = []
  for (const raw of stripThinkBlocks(reply).split('\n')) {
    const m = PROPERTIES_LINE_RE.exec(raw.trim())
    if (!m) continue
    out.push({ key: Number(m[1] ?? ''), value: (m[2] ?? '').trim() })
  }
  return out
}

/** Extracts `<result><id>N</id><translated>…</translated></result>` blocks (tolerant, no XML dependency). */
function parseXmlResults(reply: string): Array<{ key: number; value: string }> {
  const out: Array<{ key: number; value: string }> = []
  for (const m of stripThinkBlocks(reply).matchAll(XML_RESULT_RE)) {
    out.push({ key: Number(m[1]), value: (m[2] ?? '').trim() })
  }
  return out
}

/**
 * Sorts extracted `key=value` pairs by numeric key and requires the keys to be contiguous
 * starting at 1 (no gaps, no duplicates): exactly 1..maxKey. Throws a retryable
 * {@link TranslationReplyParseError} otherwise. (The expected total N is enforced downstream
 * by the line-parity check against the input line count.)
 */
function requireContiguous(
  entries: Array<{ key: number; value: string }>,
  mode: TranslateWorkMode,
): string[] {
  const byKey = new Map<number, string>()
  for (const e of entries) {
    if (byKey.has(e.key)) {
      throw new TranslationReplyParseError(mode, `duplicate id/key ${e.key}`)
    }
    byKey.set(e.key, e.value)
  }
  const maxKey = Math.max(...byKey.keys())
  const lines: string[] = []
  for (let i = 1; i <= maxKey; i++) {
    const value = byKey.get(i)
    if (value === undefined) {
      throw new TranslationReplyParseError(
        mode,
        `missing id/key ${i} (got ${byKey.size} block(s)/line(s), keys must be contiguous 1..N)`,
      )
    }
    lines.push(value)
  }
  return lines
}

/**
 * Parses a model reply for a translation unit built by `buildTranslationPrompt` (per work mode):
 *
 * - `plain` — `cleanTranslation` of the whole reply.
 * - `plan` — the `<plan>…</plan>` block is extracted separately, the remainder cleaned as `plain`.
 * - `xml` — `<result><id>N</id><translated>…</translated></result>` blocks are extracted tolerantly
 *   (prose/`<think>` noise around the XML is ignored), sorted by numeric id; missing/duplicate ids
 *   throw a retryable {@link TranslationReplyParseError}.
 * - `properties` — `N=translation` lines, sorted by numeric key; missing/duplicate keys throw a
 *   retryable {@link TranslationReplyParseError}.
 */
export function parseTranslationReply(reply: string, mode: TranslateWorkMode): ParsedTranslation {
  if (mode === 'plain') return { lines: cleanTranslation(reply).split('\n') }
  if (mode === 'plan') {
    const plan = PLAN_RE.exec(reply)?.[1]?.trim()
    const rest = plan !== undefined && plan !== '' ? reply.replace(PLAN_RE, '') : reply
    const parsed: ParsedTranslation = { lines: cleanTranslation(rest).split('\n') }
    if (plan !== undefined && plan !== '') parsed.plan = plan
    return parsed
  }
  const entries = mode === 'xml' ? parseXmlResults(reply) : parseProperties(reply)
  if (entries.length === 0) {
    throw new TranslationReplyParseError(
      mode,
      'no result blocks / key=value lines found in the reply',
    )
  }
  return { lines: requireContiguous(entries, mode) }
}
