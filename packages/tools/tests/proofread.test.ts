import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { ChatCompletionInput } from '../src/core/openrouter-tool.js'
import type { ProofreadMeta } from '../src/modification/proofread.js'
import {
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_USER_PROMPT,
  createProofreadTool,
  createProofreadXmlTool,
  proofreadTool,
  proofreadXmlTool,
} from '../src/modification/proofread.js'
import type { SchemaDocLlmCall } from '../src/normalization/schema/llm.js'

const ctx = {} as ToolContext

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
    const out = await createProofreadTool({ call }).invoke({ item: input, meta: {} }, ctx)
    expect(out.item).toContain('jump over the fence.[fixed]')
    expect(out.item).toContain('She said "hello" to him.[fixed]')
    expect(out.meta.proofread as ProofreadMeta | undefined).toBeDefined()
    expect((out.meta.proofread as ProofreadMeta).proofreadXml).toContain('<proofread>')
  })

  it('uses the bundled prompts by default', async () => {
    const call = mockProofreadCall()
    await createProofreadTool({ call }).invoke({ item: 'One paragraph.', meta: {} }, ctx)
    expect(call.calls[0]?.messages[0]?.content).toContain('Origin Text:')
    expect(call.calls[0]?.messages[0]?.content).toContain('<results>')
  })

  it('lets meta override the user prompt', async () => {
    const call = mockProofreadCall()
    await createProofreadTool({ call }).invoke(
      { item: 'One.', meta: { proofreadPrompt: '{{text}} short' } },
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
    const out = await createProofreadXmlTool({ call }).invoke({ item: inputXml, meta: {} }, ctx)
    expect(out.item).toContain('<proofread>')
    expect(out.item).toContain('<id>1</id>')
    expect(out.item).toContain('She dont like apples')
    expect(out.meta.proofreadXml as ProofreadMeta | undefined).toBeDefined()
  })

  it('exposes bundled prompt constants', () => {
    expect(PROOFREAD_SYSTEM_PROMPT).toContain('proofread')
    expect(PROOFREAD_USER_PROMPT).toContain('{{text}}')
  })
})
