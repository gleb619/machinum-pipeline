import { defineTool } from '@mt/core'
import type { Envelope, Tool, ToolContext } from '@mt/core'

import { loadBundledPrompt } from '../core/bundled-prompts.js'
import { extractPropertiesEntries, extractXmlResultEntries } from '../core/prompt-blocks.js'
import { renderPrompt } from '../normalization/schema/doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from '../normalization/schema/llm.js'
import type {
  LlmAttemptMeta,
  PromptRetryResult,
  PromptValidation,
  SchemaDocLlmCall,
  SchemaDocLlmOptions,
} from '../normalization/schema/llm.js'

// ---------------------------------------------------------------------------
// Bundled prompts
// ---------------------------------------------------------------------------

export const PROOFREAD_SYSTEM_PROMPT = loadBundledPrompt('proofread.system')
export const PROOFREAD_USER_PROMPT = loadBundledPrompt('proofread.user')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProofreadOptions extends SchemaDocLlmOptions {
  /** Source language. Default: `'en'`. */
  language?: string
}

export interface ProofreadXmlOptions extends SchemaDocLlmOptions {
  /** Source language. Default: `'en'`. */
  language?: string
}

/** LLM diagnostics plus the raw proofread XML. */
export interface ProofreadMeta extends LlmAttemptMeta {
  /** The raw XML response from the LLM. */
  proofreadXml?: string
}

interface ResultBlock {
  id: number
  text: string
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

function buildProofreadXml(paragraphs: readonly string[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<results>',
    ...paragraphs.map((text, index) => {
      const id = index + 1
      return `  <result>\n    <id>${id}</id>\n    <text>${escapeXml(text)}</text>\n  </result>`
    }),
    '</results>',
  ]
  return lines.join('\n')
}

function buildProofreadOutputXml(paragraphs: readonly string[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<results>',
    ...paragraphs.map((text, index) => {
      const id = index + 1
      return `  <result>\n    <id>${id}</id>\n    <proofread>${escapeXml(text)}</proofread>\n  </result>`
    }),
    '</results>',
  ]
  return lines.join('\n')
}

function parseResultBlocks(xml: string, tag: 'text' | 'proofread'): ResultBlock[] {
  // tolerant block extraction lives in the shared prompt-blocks module (same engine the
  // translation reply parser uses); proofread only adds entity unescaping and the id sort.
  return extractXmlResultEntries(xml, tag)
    .map((e) => ({ id: e.key, text: unescapeXml(e.value).trimEnd() }))
    .sort((a, b) => a.id - b.id)
}

function toResultMap(blocks: readonly ResultBlock[]): Map<number, string> {
  const map = new Map<number, string>()
  for (const block of blocks) {
    map.set(block.id, block.text)
  }
  return map
}

function reconstructText(paragraphs: readonly string[], proofread: Map<number, string>): string {
  const proofed = paragraphs.map((original, index) => {
    const id = index + 1
    return proofread.has(id) ? (proofread.get(id) ?? original) : original
  })
  return proofed.join('\n\n')
}

function reconstructXml(paragraphs: readonly string[], proofread: Map<number, string>): string {
  const proofed = paragraphs.map((original, index) => {
    const id = index + 1
    return proofread.has(id) ? (proofread.get(id) ?? original) : original
  })
  return buildProofreadOutputXml(proofed)
}

function validateProofreadXml(
  content: string,
  expectedIds: readonly number[],
): PromptValidation<Map<number, string>> {
  const blocks = parseResultBlocks(content, 'proofread')
  const map = toResultMap(blocks)
  const missing = expectedIds.filter((id) => !map.has(id))
  if (missing.length > 0) {
    return { ok: false, reason: `missing proofread for ids ${missing.join(', ')}` }
  }
  const empty = expectedIds.filter((id) => (map.get(id) ?? '').trim() === '')
  if (empty.length > 0) {
    return { ok: false, reason: `empty proofread for ids ${empty.join(', ')}` }
  }
  return { ok: true, value: map }
}

// ---------------------------------------------------------------------------
// Shared LLM proofreader
// ---------------------------------------------------------------------------

async function runProofread(
  inputXml: string,
  expectedIds: readonly number[],
  options: ProofreadOptions,
  env: Envelope<string>,
  ctx: ToolContext,
): Promise<{ xml: string; meta: ProofreadMeta }> {
  const language = options.language ?? 'en'
  const defaults: SchemaDocLlmOptions = {
    systemPrompt: PROOFREAD_SYSTEM_PROMPT,
    userPrompt: PROOFREAD_USER_PROMPT,
  }
  const resolved = resolveLlmOptions({ ...defaults, ...options }, env, 'proofread')

  const outcome = await runPromptWithRetry<Map<number, string>>(ctx, {
    ...resolved,
    systemPrompt: renderPrompt(resolved.systemPrompt ?? PROOFREAD_SYSTEM_PROMPT, { language }),
    userPrompt: renderPrompt(resolved.userPrompt ?? PROOFREAD_USER_PROMPT, { text: inputXml }),
    validate: (content) => validateProofreadXml(content, expectedIds),
  })

  const resultMeta: ProofreadMeta = {
    ...attemptMeta([outcome as PromptRetryResult<unknown>]),
    proofreadXml: outcome.content,
  }

  if (outcome.ok && outcome.value) {
    return { xml: outcome.content, meta: resultMeta }
  }

  // Loop guard exhausted: keep whatever is parseable, otherwise echo the input XML.
  const fallback = validateProofreadXml(outcome.content, expectedIds)
  if (fallback.ok) {
    return { xml: outcome.content, meta: resultMeta }
  }
  return { xml: inputXml, meta: resultMeta }
}

// ---------------------------------------------------------------------------
// Tool: proofread (plain text)
// ---------------------------------------------------------------------------

/**
 * Builds an LLM proofreading tool for plain text.
 *
 * Input text is split into blank-line paragraphs, sent to the LLM as XML, and
 * reconstructed from the returned `<proofread>` blocks. English is the default
 * language; pass a custom `systemPrompt`/`userPrompt` for other text kinds.
 */
export function createProofreadTool(options: ProofreadOptions = {}): Tool<string, string> {
  return defineTool<string, string>({
    name: 'proofread',
    version: '1.0.0',
    mdDescription:
      'Proofreads plain text with an LLM through the OpenRouter proxy. Splits the text into ' +
      'paragraphs, sends XML to the model, and returns the corrected text. English by default; ' +
      'prompts are fully overridable.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const text = env.item
      const paragraphs = splitParagraphs(text)
      const inputXml = buildProofreadXml(paragraphs)
      const expectedIds = paragraphs.map((_, index) => index + 1)

      const { xml, meta } = await runProofread(inputXml, expectedIds, options, env, ctx)
      const proofreadMap = toResultMap(parseResultBlocks(xml, 'proofread'))
      const proofreadText = reconstructText(paragraphs, proofreadMap)

      return {
        ...env,
        item: proofreadText,
        meta: { ...env.meta, proofread: meta },
      }
    },
  })
}

/** Default proofreading tool: English text, bundled prompts. */
export const proofreadTool = createProofreadTool()

// ---------------------------------------------------------------------------
// Tool: proofread-xml (sub tool)
// ---------------------------------------------------------------------------

/**
 * Lower-level proofreading sub tool: the input is already the XML expected by the
 * model (`<results>` with `<id>` + `<text>`), and the output is the model's XML
 * (`<id>` + `<proofread>`). Handy when callers already have paragraph XML or want
 * to chain the raw XML through another tool.
 */
export function createProofreadXmlTool(options: ProofreadXmlOptions = {}): Tool<string, string> {
  return defineTool<string, string>({
    name: 'proofread-xml',
    version: '1.0.0',
    mdDescription:
      'Lower-level proofreading sub tool. Accepts the paragraph XML expected by the proofreader ' +
      'and returns the raw `<proofread>` XML from the LLM.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const inputXml = env.item
      const inputBlocks = parseResultBlocks(inputXml, 'text')
      const expectedIds = inputBlocks.map((block) => block.id)

      const { xml, meta } = await runProofread(inputXml, expectedIds, options, env, ctx)
      const proofreadMap = toResultMap(parseResultBlocks(xml, 'proofread'))
      const originalMap = toResultMap(inputBlocks)
      const outputXml = reconstructXml(
        expectedIds.map((id) => originalMap.get(id) ?? ''),
        proofreadMap,
      )

      return {
        ...env,
        item: outputXml,
        meta: { ...env.meta, proofreadXml: meta },
      }
    },
  })
}

/** Default XML proofreading sub tool. */
export const proofreadXmlTool = createProofreadXmlTool()
// ---------------------------------------------------------------------------
// Bundled properties prompts
// ---------------------------------------------------------------------------

export const PROOFREAD_PROPERTIES_SYSTEM_PROMPT = loadBundledPrompt('proofread.properties.system')
export const PROOFREAD_PROPERTIES_USER_PROMPT = loadBundledPrompt('proofread.properties.user')

// ---------------------------------------------------------------------------
// Properties helpers
// ---------------------------------------------------------------------------

function escapeProperties(text: string): string {
  return text.replace(/\\\\/g, '\\\\\\\\').replace(/\n/g, '\\n').replace(/=/g, '\\=')
}

function parsePropertiesBlock(content: string): ResultBlock[] {
  // shared tolerant `N=value` extraction (with the Java-properties value unescaping the
  // proofread properties format uses); keys stay in document order.
  return extractPropertiesEntries(content, { unescape: true }).map((e) => ({
    id: e.key,
    text: e.value,
  }))
}

function validateProofreadProperties(
  content: string,
  expectedIds: readonly number[],
): PromptValidation<Map<number, string>> {
  const blocks = parsePropertiesBlock(content)
  const map = toResultMap(blocks)
  const missing = expectedIds.filter((id) => !map.has(id))
  if (missing.length > 0) {
    return { ok: false, reason: `missing proofread for ids ${missing.join(', ')}` }
  }
  const empty = expectedIds.filter((id) => (map.get(id) ?? '').trim() === '')
  if (empty.length > 0) {
    return { ok: false, reason: `empty proofread for ids ${empty.join(', ')}` }
  }
  return { ok: true, value: map }
}

async function runProofreadProperties(
  input: string,
  expectedIds: readonly number[],
  options: ProofreadOptions,
  env: Envelope<string>,
  ctx: ToolContext,
): Promise<{ content: string; meta: ProofreadMeta }> {
  const language = options.language ?? 'en'
  const defaults: SchemaDocLlmOptions = {
    systemPrompt: PROOFREAD_PROPERTIES_SYSTEM_PROMPT,
    userPrompt: PROOFREAD_PROPERTIES_USER_PROMPT,
  }
  const resolved = resolveLlmOptions({ ...defaults, ...options }, env, 'proofreadProperties')

  const outcome = await runPromptWithRetry<Map<number, string>>(ctx, {
    ...resolved,
    systemPrompt: renderPrompt(resolved.systemPrompt ?? PROOFREAD_PROPERTIES_SYSTEM_PROMPT, {
      language,
    }),
    userPrompt: renderPrompt(resolved.userPrompt ?? PROOFREAD_PROPERTIES_USER_PROMPT, {
      text: input,
    }),
    validate: (content) => validateProofreadProperties(content, expectedIds),
  })

  const resultMeta: ProofreadMeta = {
    ...attemptMeta([outcome as PromptRetryResult<unknown>]),
    proofreadXml: outcome.content,
  }

  if (outcome.ok && outcome.value) {
    return { content: outcome.content, meta: resultMeta }
  }

  const fallback = validateProofreadProperties(outcome.content, expectedIds)
  if (fallback.ok) {
    return { content: outcome.content, meta: resultMeta }
  }
  return { content: input, meta: resultMeta }
}

// ---------------------------------------------------------------------------
// Tool: proofread-properties (sub tool)
// ---------------------------------------------------------------------------

/**
 * Lower-level proofreading sub tool using Java properties format. Input must be
 * one `key=value` per line where the key is the id/line number and the value is
 * the original text. Output is the same set of keys with proofread values.
 */
export function createProofreadPropertiesTool(
  options: ProofreadOptions = {},
): Tool<string, string> {
  return defineTool<string, string>({
    name: 'proofread-properties',
    version: '1.0.0',
    mdDescription:
      'Lower-level proofreading sub tool using Java properties format. ' +
      'Accepts one key=value per line (key = id/line number, value = original text) ' +
      'and returns the same keys with proofread values.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const input = env.item
      const inputBlocks = parsePropertiesBlock(input)
      const expectedIds = inputBlocks.map((block) => block.id)

      const { content, meta } = await runProofreadProperties(input, expectedIds, options, env, ctx)
      const proofreadMap = toResultMap(parsePropertiesBlock(content))
      const originalMap = toResultMap(inputBlocks)

      const lines: string[] = []
      for (const id of expectedIds) {
        const value = proofreadMap.has(id)
          ? (proofreadMap.get(id) ?? '')
          : (originalMap.get(id) ?? '')
        lines.push(`${id}=${escapeProperties(value)}`)
      }

      return {
        ...env,
        item: lines.join('\n'),
        meta: { ...env.meta, proofreadProperties: meta },
      }
    },
  })
}

/** Default properties proofreading sub tool. */
export const proofreadPropertiesTool = createProofreadPropertiesTool()
