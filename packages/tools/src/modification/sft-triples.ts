import { category, defineTool, tool, withItem, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/**
 * Turns pipeline artifacts into fine-tuning triples (TL254).
 *
 * Input is a JSONL text; every non-blank line is one record in one of three source shapes:
 *
 *   1. `{ system?, user, reply }` (or `assistant` instead of `reply`) - the shape written by
 *      `MT_TRANSLATE_PROMPT_LOG` / teacher runs;
 *   2. `{ messages: [{ role, content }, ...] }` - a chat record (roles `system|user|assistant`);
 *   3. `{ chapter, pairs: [{ src, tgt }, ...], system? }` - parallel chapter pairs.
 *
 * Every record is normalised to one canonical chat triple: an optional `system` turn, then one
 * `user` turn and one `assistant` turn. A `messages` record is collapsed to the last user turn
 * and the assistant turn that follows it (earlier turns are context, not the training target).
 * Records (or chapter pairs) whose assistant turn is empty, whose prompt is echoed back verbatim
 * by the assistant, or whose shape does not match one of the three are dropped and counted per
 * reason in `meta.dropped`; the rest are emitted as JSONL of `{ messages }` objects.
 */

/** Chat roles accepted from `messages` arrays and emitted in a triple. */
export type ChatRole = 'system' | 'user' | 'assistant'

/** One chat turn. */
export interface ChatTurn {
  role: ChatRole
  content: string
}

/** Canonical training example: `system? -> user -> assistant`. */
export interface ChatTriple {
  messages: ChatTurn[]
}

/** Why a record (or a chapter pair) did not become a triple. */
export type SftDropReason =
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-pair'
  | 'empty-pairs'
  | 'empty-user'
  | 'empty-assistant'
  | 'prompt-echo'

/** Envelope metadata written by the tool. */
export interface SftTriplesStats {
  /** Non-blank input lines. */
  recordsIn: number
  /** Emitted triples. */
  recordsOut: number
  /** Drop counts, keyed by reason; reasons with no occurrences are absent. */
  dropped: Partial<Record<SftDropReason, number>>
}

/** Result of the pure conversion. */
export interface SftTriplesResult {
  jsonl: string
  stats: SftTriplesStats
}

/** A normalised triple before validation (`reply` is the assistant turn). */
interface RawTriple {
  system?: string
  user: string
  assistant: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value when it is a string (empty included - emptiness is classified later). */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The trimmed value when it is a non-empty string. */
function textField(value: unknown): string | undefined {
  const text = stringField(value)?.trim()
  return text === undefined || text === '' ? undefined : text
}

/** Whitespace/case-insensitive comparison form used for prompt-echo detection. */
function echoForm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Detects an assistant turn that only repeats the prompt. Compared on the whitespace-collapsed,
 * lower-cased text, so a copy of the prompt with different line wrapping still counts.
 */
export function isPromptEcho(assistant: string, user: string): boolean {
  const a = echoForm(assistant)
  const u = echoForm(user)
  if (a === '' || u === '') return false
  return a === u
}

/**
 * Collapses a chat record to `system` (every leading system turn joined by blank lines), the last
 * user turn, and the assistant turn that follows it. Returns a drop reason when either turn is
 * missing.
 */
function collapseTurns(turns: ChatTurn[]): RawTriple | SftDropReason {
  let lastUser = -1
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser === -1) return 'empty-user'

  const systems: string[] = []
  for (let i = 0; i < lastUser; i += 1) {
    const turn = turns[i]
    if (turn?.role === 'system') systems.push(turn.content)
  }
  const system = textField(systems.filter((s) => s.trim() !== '').join('\n\n'))

  let assistant: RawTriple['assistant'] | undefined
  for (let i = lastUser + 1; i < turns.length; i += 1) {
    if (turns[i]?.role === 'assistant') {
      assistant = turns[i]?.content
      break
    }
  }
  if (assistant === undefined) return 'empty-assistant'

  return { system, user: turns[lastUser]?.content ?? '', assistant }
}

/** Parses one JSONL record into triples (chapter pairs give several) or drop reasons. */
function readRecord(value: unknown): Array<RawTriple | SftDropReason> {
  if (!isRecord(value)) return ['invalid-shape']

  if (Array.isArray(value.messages)) {
    const turns: ChatTurn[] = []
    for (const entry of value.messages) {
      if (!isRecord(entry)) return ['invalid-shape']
      const role = entry.role
      if (role !== 'system' && role !== 'user' && role !== 'assistant') return ['invalid-shape']
      const content = stringField(entry.content)
      if (content === undefined) return ['invalid-shape']
      turns.push({ role, content })
    }
    return [collapseTurns(turns)]
  }

  if (typeof value.chapter === 'string' && Array.isArray(value.pairs)) {
    if (value.pairs.length === 0) return ['empty-pairs']
    const system = textField(value.system)
    const out: Array<RawTriple | SftDropReason> = []
    for (const pair of value.pairs) {
      if (!isRecord(pair)) {
        out.push('invalid-pair')
        continue
      }
      const src = stringField(pair.src)
      const tgt = stringField(pair.tgt)
      if (src === undefined || tgt === undefined) {
        out.push('invalid-pair')
        continue
      }
      out.push({ system, user: src, assistant: tgt })
    }
    return out
  }

  const user = stringField(value.user)
  const assistant = stringField(value.reply) ?? stringField(value.assistant)
  if (user === undefined || assistant === undefined) return ['invalid-shape']
  return [{ system: textField(value.system), user, assistant }]
}

/** Validates a raw triple and turns it into the canonical `{ messages }` shape. */
function toTriple(raw: RawTriple): ChatTriple | SftDropReason {
  const user = raw.user.trim()
  const assistant = raw.assistant.trim()
  const system = raw.system?.trim()
  if (user === '') return 'empty-user'
  if (assistant === '') return 'empty-assistant'
  if (isPromptEcho(assistant, user)) return 'prompt-echo'

  const messages: ChatTurn[] = []
  if (system !== undefined && system !== '') messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: user }, { role: 'assistant', content: assistant })
  return { messages }
}

function countDrop(dropped: Partial<Record<SftDropReason, number>>, reason: SftDropReason): void {
  dropped[reason] = (dropped[reason] ?? 0) + 1
}

/** Pure conversion: JSONL records -> canonical triples JSONL + stats. */
export function buildSftTriples(jsonl: string): SftTriplesResult {
  const records = jsonl.split('\n').filter((line) => line.trim() !== '')
  const dropped: Partial<Record<SftDropReason, number>> = {}
  const lines: string[] = []
  let recordsOut = 0

  for (const line of records) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      countDrop(dropped, 'invalid-json')
      continue
    }

    for (const entry of readRecord(value)) {
      if (typeof entry === 'string') {
        countDrop(dropped, entry)
        continue
      }
      const triple = toTriple(entry)
      if (typeof triple === 'string') {
        countDrop(dropped, triple)
        continue
      }
      lines.push(JSON.stringify(triple))
      recordsOut += 1
    }
  }

  return {
    jsonl: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    stats: { recordsIn: records.length, recordsOut, dropped },
  }
}

/**
 * Normalises pipeline artifacts (teacher prompt logs, chat records, parallel chapter pairs) into
 * canonical `system? -> user -> assistant` chat triples. Records with an empty assistant turn or
 * a verbatim prompt echo are dropped; counts land in `meta.recordsIn` / `meta.recordsOut` /
 * `meta.dropped` (keyed by reason, reasons with no occurrences omitted).
 */
export const sftTriples = defineTool<string, string>({
  name: 'sft-triples',
  version: '1.0.0',
  mdDescription:
    'Normalises JSONL records (system/user/reply, `messages`, or chapter `pairs`) into canonical chat triples; drops empty-assistant and prompt-echo records and counts them in `meta.dropped`.',
  annotations: [
    tool('TL254', {
      name: 'sft-triples',
      description: 'Normalises JSONL records into canonical chat triples for fine-tuning.',
      refs: [],
    }),
    category(['serializer']),
  ],
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    if (typeof env.item !== 'string') {
      throw new Error(
        'sft-triples: item must be a JSONL string (one record per line); use a json/jsonl source or a parser tool before this one',
      )
    }
    const { jsonl, stats } = buildSftTriples(env.item)
    return withMeta(withItem(env, jsonl), {
      recordsIn: stats.recordsIn,
      recordsOut: stats.recordsOut,
      dropped: stats.dropped,
    })
  },
})
