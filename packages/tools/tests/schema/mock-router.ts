import type { ToolContext } from '@mt/core'
import { vi } from 'vitest'

export interface RouterCall {
  url: string
  model: string
  messages: { role: string; content: string }[]
  temperature?: number
  max_tokens?: number
}

/** A reply: markdown/CSV text, a thrown transport error, or an HTTP failure. */
export type RouterReply = string | Error | { status: number; body?: string }

export interface MockRouter {
  calls: RouterCall[]
  lastPrompt(): string
  restore(): void
}

/**
 * Stubs `fetch` for the OpenRouter proxy endpoint so schema-doc tools can be tested
 * without a running router. Replies are consumed in order; the last one repeats.
 */
export function installRouter(
  replies: RouterReply[] | ((call: RouterCall, index: number) => RouterReply),
): MockRouter {
  const calls: RouterCall[] = []
  const originalFetch = globalThis.fetch
  const resolver =
    typeof replies === 'function'
      ? replies
      : (_call: RouterCall, index: number): RouterReply =>
          replies[Math.min(index, replies.length - 1)] ?? new Error('no canned reply')

  globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const call: RouterCall = {
      url: String(input),
      model: String(payload.model ?? ''),
      messages: (payload.messages ?? []) as { role: string; content: string }[],
    }
    if (typeof payload.temperature === 'number') call.temperature = payload.temperature
    if (typeof payload.max_tokens === 'number') call.max_tokens = payload.max_tokens
    calls.push(call)

    const reply = resolver(call, calls.length - 1)
    if (reply instanceof Error) {
      throw reply
    }
    if (typeof reply !== 'string') {
      return new Response(reply.body ?? 'router unavailable', { status: reply.status })
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply } }],
        model: call.model || 'openai/gpt-4o-mini',
        usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  return {
    calls,
    lastPrompt(): string {
      const messages = calls[calls.length - 1]?.messages ?? []
      return messages[messages.length - 1]?.content ?? ''
    },
    restore(): void {
      globalThis.fetch = originalFetch
    },
  }
}

/** Minimal run context: the schema-doc tools only read `ctx.run.global.routerUrl`. */
export function toolContext(routerUrl = 'http://router.test'): ToolContext {
  return { run: { global: { routerUrl } } } as unknown as ToolContext
}

export const CHAPTER = [
  '# Chapter 1: The Road from Thornhaven',
  '',
  'Sir Aldric rode out of Thornhaven at dawn, alone except for his grey mare.',
  'The road into the Darkwood narrowed until the trees closed in like witnesses.',
  'By midday Aldric counted his coins and thought of the Duke’s tribunal waiting in Thornhaven.',
  'He had promised the miller’s daughter he would return before the harvest festival.',
].join('\n')

export const CHAPTER_TWO = [
  '# Chapter 2: Ambush in the Darkwood',
  '',
  'Arrows hissed through the Darkwood canopy before Aldric saw a single archer.',
  'His mare fell, and Aldric rolled behind an oak to think.',
  'The ambushers called themselves the Duke’s men, which puzzled Aldric.',
].join('\n')

export const SUMMARY_REPLY =
  'Sir Aldric rides out of Thornhaven toward the Darkwood with his grey mare, counting his coins ' +
  'and worrying about the Duke’s tribunal, after promising the miller’s daughter a quick return.'

export const ENTITIES_REPLY = [
  'index,name',
  '1,Sir Aldric',
  '2,Thornhaven',
  '3,Darkwood',
  '4,The Duke',
].join('\n')

export const SCHEMA_REPLY = [
  '```mermaid',
  'graph TD',
  '    Thornhaven --> Road',
  '    Road --> Darkwood',
  '    Aldric --> Tribunal',
  '```',
].join('\n')

export const VOCABULARY_REPLY = ['word', 'aldric', 'thornhaven', 'darkwood', 'tribunal'].join('\n')
