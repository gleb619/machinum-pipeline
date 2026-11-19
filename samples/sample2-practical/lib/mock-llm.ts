import { appendFileSync } from 'node:fs'
import type { ProcessBuilder } from '@mt/core'
import {
  type InstalledLlmProvider,
  type LlmRequest,
  type MockLlmOptions,
  mockLlm,
  summarizeHeuristic,
} from '@mt/tools'
import { assertRealBackend, usesMockBackend } from './llm.js'
import { MOCK_NER_ANSWER } from './mock-ner.js'

/** Install the sample-wide mock only when the resolved backend is `mock`. */
export function installSampleMock(process: ProcessBuilder): ProcessBuilder {
  if (!usesMockBackend()) return process
  assertRealBackend('sample2', 'mock')
  const options: MockLlmOptions = { source: sampleMockAnswer }
  const provider: InstalledLlmProvider = mockLlm(options)
  return process.install(provider)
}

let xmlCalls = 0

/** One answer source for every sample2 LLM stage. */
export function sampleMockAnswer(req: LlmRequest): string {
  const system = systemText(req)
  const user = lastUser(req)

  // Every `xml` prompt (batch titles and chapter body blocks) wraps its input in
  // `<result><id>N</id><origin>..</origin></result>` and expects a mirrored reply.
  if (hasXmlBlocks(user)) return xmlBlocksAnswer(system, user)
  if (system.includes('The text is a chapter title')) return translateLatin(user)
  if (system.includes('Chapter summary (context only')) {
    return xmlBlocksAnswer(system, user)
  }
  if (system.includes('Web Novel Summary Notes Generator')) {
    const heading = /^#\s+.+$/m.exec(user)
    const body = heading ? user.slice((heading.index ?? 0) + heading[0].length) : user
    return summarizeHeuristic(body, { sentences: 3 }).replace(/\s+/g, ' ').trim()
  }
  if (system.includes('Web Novel Glossary Extractor')) return MOCK_NER_ANSWER
  if (system.includes('LLM_TYPO_FIX_PROMPT') || system.includes('Fix only obvious typos')) {
    return user
  }
  return 'mock'
}

/** True when the user prompt carries `<result><id>N</id>..</result>` blocks. */
function hasXmlBlocks(user: string): boolean {
  return /<result>\s*<id>\s*\d+\s*<\/id>/.test(user)
}

/**
 * Mirrors `<result><id>N</id><origin>text</origin></result>` blocks as
 * `<result><id>N</id><translated>..</translated></result>`. This covers both the batch
 * title request and the chapter body request, and tolerates a missing `<origin>`.
 */
function xmlBlocksAnswer(system: string, user: string): string {
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  xmlCalls += 1
  // Fail both attempts of the first body block, so the per-line fallback has to take over.
  if (process.env.MT_MOCK_FLAKY === '1' && (xmlCalls === 2 || xmlCalls === 3)) return ''

  const out: string[] = []
  for (const block of user.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const inner = block[1] ?? ''
    const id = /<id>\s*(\d+)\s*<\/id>/.exec(inner)?.[1]
    if (id === undefined) continue
    const origin = /<origin>([\s\S]*?)<\/origin>/.exec(inner)?.[1] ?? ''
    out.push(`<result><id>${id}</id><translated>${translateLatin(origin)}</translated></result>`)
  }
  if (out.length === 0) return translateLatin(user)
  return out.join('\n')
}

function systemText(req: LlmRequest): string {
  const messages = req.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
  return [...(req.system ? [req.system] : []), ...messages].join('\n')
}

function lastUser(req: LlmRequest): string {
  return [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

function translateLatin(text: string): string {
  return text.replace(/[A-Za-z]+/g, 'слово')
}
