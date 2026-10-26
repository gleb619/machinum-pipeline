import { StructuredReplyParseError, parseStructuredReply } from '../core/prompt-blocks.js'
import { cleanTranslation } from './translation-prompt.js'
import type { TranslateWorkMode } from './translation-prompt.js'

/** Parsed model reply of a translation request. */
export interface ParsedTranslation {
  /** Translated lines in input order (line 1 first). */
  lines: string[]
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

/**
 * Parses a model reply for a translation unit built by `buildTranslationPrompt` (per work mode):
 *
 * - `plain` — `cleanTranslation` of the whole reply.
 * - `xml` — `<result><id>N</id><translated>…</translated></result>` blocks are extracted tolerantly
 *   (prose/`<think>` noise around the XML is ignored), sorted by numeric id; missing/duplicate ids
 *   throw a retryable {@link TranslationReplyParseError}.
 * - `properties` — `N=translation` lines, sorted by numeric key; missing/duplicate keys throw a
 *   retryable {@link TranslationReplyParseError}.
 *
 * The structured-mode extraction and the contiguous 1..N check live in the shared
 * {@link parseStructuredReply} (`src/core/prompt-blocks.ts`), also used by the proofread tools.
 */
export function parseTranslationReply(reply: string, mode: TranslateWorkMode): ParsedTranslation {
  if (mode === 'plain') return { lines: cleanTranslation(reply).split('\n') }
  try {
    return { lines: parseStructuredReply(reply, mode) }
  } catch (err) {
    if (err instanceof StructuredReplyParseError) {
      throw new TranslationReplyParseError(mode, err.detail)
    }
    throw err
  }
}
