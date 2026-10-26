import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { ChatCompletionInput } from '../src/core/openrouter-tool.js'
import type { ProofreadMeta } from '../src/modification/proofread.js'
import {
  PROOFREAD_PROPERTIES_SYSTEM_PROMPT,
  PROOFREAD_PROPERTIES_USER_PROMPT,
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_USER_PROMPT,
  createProofreadPropertiesTool,
  createProofreadTool,
  createProofreadXmlTool,
  proofreadPropertiesTool,
  proofreadTool,
  proofreadXmlTool,
} from '../src/modification/proofread.js'
import type { SchemaDocLlmCall } from '../src/normalization/schema/llm.js'

const ctx = {} as ToolContext

function makeEnv(item: string): {
  id: string
  item: string
  meta: Record<string, unknown>
  variables: []
} {
  return { id: 'ex-test', item, meta: {}, variables: [] }
}

function mockProofreadPropertiesCall(): SchemaDocLlmCall & { calls: ChatCompletionInput[] } {
  const calls: ChatCompletionInput[] = []
  const call: SchemaDocLlmCall = async (input) => {
    calls.push(input)
    const content = input.messages[0]?.content ?? ''
    const lines: string[] = []
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (line === '') continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const id = line.slice(0, eq)
      let value = line.slice(eq + 1)
      value = value.replace(/dont/g, 'do not').replace(/jump(?= over)/g, 'jumps')
      lines.push(`${id}=${value}`)
    }
    return {
      content: lines.join('\n'),
      model: 'mock',
      tokens: 1,
      promptTokens: 1,
      completionTokens: 1,
    }
  }
  return Object.assign(call, { calls })
}

function mockProofreadCall(
  suffix = '[fixed]',
): SchemaDocLlmCall & { calls: ChatCompletionInput[] } {
  const calls: ChatCompletionInput[] = []
  const call: SchemaDocLlmCall = async (input) => {
    calls.push(input)
    const content = input.messages[0]?.content ?? ''
    const xmlMatch = /(<results>[\s\S]*?<\/results>)/.exec(content)
    const xml = xmlMatch?.[1] ?? content
    const proofread = xml
      .replace(/<text>/g, '<proofread>')
      .replace(/<\/text>/g, '</proofread>')
      .replace(/(<proofread>[\s\S]*?<\/proofread>)/g, (m) => {
        const inner = m.slice(11, -12).trimEnd()
        return `<proofread>${inner}${suffix}</proofread>`
      })
    return {
      content: `<?xml version="1.0" encoding="UTF-8"?>\n${proofread}`,
      model: 'mock',
      tokens: 1,
      promptTokens: 1,
      completionTokens: 1,
    }
  }
  return Object.assign(call, { calls })
}

describe('proofreadTool', () => {
  it('has the expected name and version', () => {
    expect(proofreadTool.name).toBe('proofread')
    expect(proofreadTool.version).toBe('1.0.0')
  })

  it('proofreads each paragraph and preserves structure', async () => {
    const input = `The quick brown fox jump over the fence.\n\nShe said "hello" to him.`
    const call = mockProofreadCall()
    const out = await createProofreadTool({ call }).invoke(makeEnv(input), ctx)
    expect(out.item).toContain('jump over the fence.[fixed]')
    expect(out.item).toContain('She said "hello" to him.[fixed]')
    expect(out.meta.proofread as ProofreadMeta | undefined).toBeDefined()
    expect((out.meta.proofread as ProofreadMeta).proofreadXml).toContain('<proofread>')
  })

  it('uses the bundled prompts by default', async () => {
    const call = mockProofreadCall()
    await createProofreadTool({ call }).invoke(makeEnv('One paragraph.'), ctx)
    expect(call.calls[0]?.messages[0]?.content).toContain('Origin Text:')
    expect(call.calls[0]?.messages[0]?.content).toContain('<results>')
  })

  it('tolerates think-block noise and XML preamble via the shared structured parser', async () => {
    const input = 'The fox jump over the fence.\n\nShe dont like apples.'
    const call: SchemaDocLlmCall = async () => ({
      content:
        '<think>let me proofread…</think>\n<?xml version="1.0" encoding="UTF-8"?>\n<results>\n' +
        '  <result>\n    <id>1</id>\n    <proofread>The fox jumps over the fence.</proofread>\n  </result>\n' +
        '  <result>\n    <id>2</id>\n    <proofread>She does not like apples.</proofread>\n  </result>\n' +
        '</results>',
      model: 'mock',
      tokens: 1,
      promptTokens: 1,
      completionTokens: 1,
    })
    const out = await createProofreadTool({ call }).invoke(makeEnv(input), ctx)
    expect(out.item).toBe('The fox jumps over the fence.\n\nShe does not like apples.')
  })

  it('lets meta override the user prompt', async () => {
    const call = mockProofreadCall()
    await createProofreadTool({ call }).invoke(
      { id: 'ex-test', item: 'One.', meta: { proofreadPrompt: '{{text}} short' }, variables: [] },
      ctx,
    )
    expect(call.calls[0]?.messages[0]?.content).toContain('short')
  })
})

describe('proofreadXmlTool', () => {
  it('has the expected name and version', () => {
    expect(proofreadXmlTool.name).toBe('proofread-xml')
    expect(proofreadXmlTool.version).toBe('1.0.0')
  })

  it('returns proofread XML from input XML', async () => {
    const inputXml = `<?xml version="1.0" encoding="UTF-8"?>
<results>
  <result>
    <id>1</id>
    <text>She dont like apples.</text>
  </result>
</results>`
    const call = mockProofreadCall('')
    const out = await createProofreadXmlTool({ call }).invoke(makeEnv(inputXml), ctx)
    expect(out.item).toContain('<proofread>')
    expect(out.item).toContain('<id>1</id>')
    expect(out.item).toContain('She dont like apples')
    expect(out.meta.proofreadXml as ProofreadMeta | undefined).toBeDefined()
  })

  it('exposes bundled prompt constants', () => {
    expect(PROOFREAD_SYSTEM_PROMPT).toContain('proofread')
    expect(PROOFREAD_USER_PROMPT).toContain('{{text}}')
    expect(PROOFREAD_PROPERTIES_USER_PROMPT).toContain('{{text}}')
  })
})

describe('proofreadPropertiesTool', () => {
  it('has the expected name and version', () => {
    expect(proofreadPropertiesTool.name).toBe('proofread-properties')
    expect(proofreadPropertiesTool.version).toBe('1.0.0')
  })

  it('proofreads properties lines and keeps keys', async () => {
    const input = '1=She dont like apples.\n2=The quick brown fox jump over the fence.'
    const call = mockProofreadPropertiesCall()
    const out = await createProofreadPropertiesTool({ call }).invoke(makeEnv(input), ctx)
    expect(out.item).toContain('1=She do not like apples.')
    expect(out.item).toContain('2=The quick brown fox jumps over the fence.')
    expect(out.meta.proofreadProperties as ProofreadMeta | undefined).toBeDefined()
  })

  it('falls back to input when output is unparseable', async () => {
    const input = '1=Hello world.'
    const call: SchemaDocLlmCall = async () => ({
      content: 'not properties',
      model: 'mock',
      tokens: 1,
      promptTokens: 1,
      completionTokens: 1,
    })
    const out = await createProofreadPropertiesTool({ call }).invoke(makeEnv(input), ctx)
    expect(out.item).toBe(input)
  })
})
