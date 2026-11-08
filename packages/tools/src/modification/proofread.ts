import { category, defineTool, setVariable, tool, useCase } from '@mt/core'
import type { Annotation, Envelope, Tool, ToolContext } from '@mt/core'

import { loadBundledPrompt } from '../core/bundled-prompts.js'
import {
  type ChunkBudget,
  DEFAULT_OUTPUT_RESERVE,
  type SemanticUnit,
  estimateOverhead,
  groupItemsToBudget,
  processChunks,
  resolveChunkBudget,
  toChunkRecord,
} from '../core/chunk-processor.js'
import { extractPropertiesEntries, extractXmlResultEntries } from '../core/prompt-blocks.js'
import { renderPrompt } from '../normalization/schema/doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from '../normalization/schema/llm.js'
import type {
  LlmAttemptMeta,
  PromptRetryResult,
  PromptValidation,
  SchemaDocLlmOptions,
} from '../normalization/schema/llm.js'
import { countTextTokens } from '../normalization/token-counter.js'
import { resolveTunedNum } from '../resolve-constants.js'

// ---------------------------------------------------------------------------
// Bundled prompts
// ---------------------------------------------------------------------------

export const PROOFREAD_SYSTEM_PROMPT = loadBundledPrompt('proofread.system')
export const PROOFREAD_USER_PROMPT = loadBundledPrompt('proofread.user')
export const PROOFREAD_PROPERTIES_SYSTEM_PROMPT = loadBundledPrompt('proofread.properties.system')
export const PROOFREAD_PROPERTIES_USER_PROMPT = loadBundledPrompt('proofread.properties.user')

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

export type ProofreadChunkMode = 'shrink' | 'chunk' | 'auto'

export interface ProofreadChunkOptions {
  chunkMode?: ProofreadChunkMode
  outputReserve?: number
  reserve?: number
  splitUnit?: SemanticUnit
  chunkConcurrency?: number
}

interface ResultBlock {
  id: number
  text: string
}

/** The annotation block shared by the three proofreading tools. */
function proofreadAnnotations(id: string, name: string, description: string): Annotation[] {
  return [
    tool(id, { name, description, refs: ['UC058'] }),
    useCase('UC058'),
    category(['validator', 'llm']),
  ]
}

// ---------------------------------------------------------------------------
// Helpers and variant description
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

/** Wraps `<result>` fragments into a `<results>` document. */
function wrapResults(fragments: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<results>\n${fragments.join('\n')}\n</results>`
}

/** A `<results>` document of `<result>` blocks; `tag` is the payload element. */
function buildResultsXml(
  items: readonly string[],
  firstId = 1,
  tag: 'text' | 'proofread' = 'text',
): string {
  return wrapResults(
    items.map(
      (text, index) =>
        `  <result>\n    <id>${firstId + index}</id>\n    <${tag}>${escapeXml(text)}</${tag}>\n  </result>`,
    ),
  )
}

function parseResultBlocks(xml: string, tag: 'text' | 'proofread'): ResultBlock[] {
  // tolerant block extraction lives in the shared prompt-blocks module (same engine the
  // translation reply parser uses); proofread only adds entity unescaping and the id sort.
  return extractXmlResultEntries(xml, tag)
    .map((e) => ({ id: e.key, text: unescapeXml(e.value).trimEnd() }))
    .sort((a, b) => a.id - b.id)
}

/** The answer blocks of the XML flavours (`<proofread>` entries). */
function parseProofreadAnswer(content: string): ResultBlock[] {
  return parseResultBlocks(content, 'proofread')
}

function toResultMap(blocks: readonly ResultBlock[]): Map<number, string> {
  const map = new Map<number, string>()
  for (const block of blocks) {
    map.set(block.id, block.text)
  }
  return map
}

/** The proofread value of every paragraph, falling back to the original text. */
function proofreadParagraphs(
  paragraphs: readonly string[],
  proofread: Map<number, string>,
): string[] {
  return paragraphs.map((original, index) => {
    const id = index + 1
    return proofread.has(id) ? (proofread.get(id) ?? original) : original
  })
}

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

/**
 * One proofreading flavour: how the input is split, what is sent to the model, how the answer
 * is parsed back and how the output item is rebuilt. The three proofreading tools are three
 * flavours of the same flow.
 */
interface ProofreadVariant {
  name: string
  version: string
  mdDescription: string
  annotations: readonly Annotation[]
  /** Default system prompt. */
  system: string
  /** Default user prompt. */
  user: string
  /** Prefix of the per-envelope prompt overrides (`<key>Prompt` / `<key>SystemPrompt`). */
  optionKey: string
  /** Splits the tool input into ordered blocks and builds the model payload. */
  prepare: (input: string) => { blocks: ResultBlock[]; payload: string }
  /** Parses the model answer into ordered blocks. */
  parseAnswer: (content: string) => ResultBlock[]
  /** Rebuilds the output item from the single-call answer or the merged chunk answers. */
  wrap: (blocks: readonly ResultBlock[], run: ProofreadRun) => string
  /** Splits the input into per-call payloads under the budget. Absent = no chunk modes. */
  group?: (blocks: readonly ResultBlock[], budget: ChunkBudget) => string[]
  /** Variable the chunk metadata is published under. */
  chunksVariable?: string
  /** Meta key of the diagnostics. */
  metaKey: 'proofread' | 'proofreadXml' | 'proofreadProperties'
}

/** What one proofreading pass produced. */
interface ProofreadRun {
  answer: string
  merged?: Map<number, string>
}

/** Everything one proofreading pass needs besides its payload and expected ids. */
interface ProofreadCall {
  variant: ProofreadVariant
  options: ProofreadOptions & ProofreadChunkOptions
  env: Envelope<string>
  ctx: ToolContext
}

// ---------------------------------------------------------------------------
// Shared LLM proofreader and chunk budget
// ---------------------------------------------------------------------------

/** Rejects an answer that misses an id or carries an empty value for it. */
function validateProofreadBlocks(
  content: string,
  expectedIds: readonly number[],
  parse: (content: string) => ResultBlock[],
): PromptValidation<Map<number, string>> {
  const map = toResultMap(parse(content))
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

/**
 * Sends one payload to the model and re-prompts until the answer carries every expected id.
 * Never throws: when the guard is exhausted the parseable part is kept, otherwise the input
 * payload is echoed back.
 */
async function runProofread(
  payload: string,
  expectedIds: readonly number[],
  call: ProofreadCall,
): Promise<{ content: string; meta: ProofreadMeta }> {
  const { variant, options, env, ctx } = call
  const language = options.language ?? 'en'
  const resolved = resolveLlmOptions(
    { systemPrompt: variant.system, userPrompt: variant.user, ...options },
    env,
    variant.optionKey,
  )

  const outcome = await runPromptWithRetry<Map<number, string>>(ctx, {
    ...resolved,
    systemPrompt: renderPrompt(resolved.systemPrompt ?? variant.system, { language }),
    userPrompt: renderPrompt(resolved.userPrompt ?? variant.user, { text: payload }),
    validate: (content) => validateProofreadBlocks(content, expectedIds, variant.parseAnswer),
  })

  const meta: ProofreadMeta = {
    ...attemptMeta([outcome as PromptRetryResult<unknown>]),
    proofreadXml: outcome.content,
  }

  // Loop guard exhausted: keep whatever is parseable, otherwise echo the input payload.
  const parsed = validateProofreadBlocks(outcome.content, expectedIds, variant.parseAnswer)
  const content =
    outcome.ok && outcome.value ? outcome.content : parsed.ok ? outcome.content : payload
  return { content, meta }
}

function proofreadBudget(call: ProofreadCall): ChunkBudget | null {
  const { options, env, ctx } = call
  const resolved = resolveLlmOptions({ ...options }, env, 'proofread')
  const system = resolved.systemPrompt ?? PROOFREAD_SYSTEM_PROMPT
  const userPrefix = renderPrompt(resolved.userPrompt ?? PROOFREAD_USER_PROMPT, { text: '' })
  const overhead = estimateOverhead(system, userPrefix)
  return resolveChunkBudget({
    ctx,
    input: {
      model: resolved.model,
      outputReserve:
        options.outputReserve ??
        options.maxTokens ??
        resolveTunedNum('DEFAULT_OUTPUT_RESERVE', DEFAULT_OUTPUT_RESERVE, env, ctx),
      overhead,
      reserve: options.reserve,
    },
    llmConfig: resolved,
  })
}

/**
 * Proofreads pre-built group XMLs (one LLM call each) on the shared {@link processChunks}
 * loop and merges the results by id. Used by `proofread` and `proofread-xml`.
 */
async function proofreadGroupXmls(
  groupXmls: string[],
  call: ProofreadCall,
): Promise<{ merged: Map<number, string>; meta: ProofreadMeta }> {
  const { variant } = call
  type GroupOutcome = { map: Map<number, string>; rawXml: string; meta: ProofreadMeta }
  const outcome = await processChunks<GroupOutcome[]>({
    chunks: groupXmls,
    process: async (groupXml) => {
      const groupIds = parseResultBlocks(groupXml, 'text').map((b) => b.id)
      const r = await runProofread(groupXml, groupIds, call)
      return [{ map: toResultMap(variant.parseAnswer(r.content)), rawXml: r.content, meta: r.meta }]
    },
    merge: (parts) => parts.flat(),
    concurrency: call.options.chunkConcurrency ?? 2,
  })

  const merged = new Map<number, string>()
  let rawXml = ''
  let attempts = 0
  let tokens = 0
  let lastFailure: string | undefined
  for (const o of outcome) {
    for (const [id, text] of o.map) merged.set(id, text)
    rawXml += o.rawXml
    attempts += o.meta.attempts ?? 0
    tokens += o.meta.tokens ?? 0
    if (o.meta.lastFailure) lastFailure = o.meta.lastFailure
  }
  return {
    merged,
    meta: { attempts, tokens, fallbackUsed: false, lastFailure, proofreadXml: rawXml },
  }
}

// ---------------------------------------------------------------------------
// Shared factory
// ---------------------------------------------------------------------------

/**
 * Builds a proofreading tool from a flavour description: one call over the whole input
 * (`shrink`), or one call per budget-sized group (`chunk` / `auto`) merged back by id.
 */
function createProofreadVariantTool(
  variant: ProofreadVariant,
  options: ProofreadOptions & ProofreadChunkOptions = {},
): Tool<string, string> {
  const { chunkMode = 'shrink', ...proofOptions } = options

  return defineTool<string, string>({
    name: variant.name,
    version: variant.version,
    mdDescription: variant.mdDescription,
    annotations: variant.annotations,
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const { blocks, payload } = variant.prepare(env.item)
      const expectedIds = blocks.map((block) => block.id)
      const call: ProofreadCall = { variant, options: proofOptions, env, ctx }

      // Chunking is off unless the flavour groups, the mode asks for it and the payload
      // does not fit the budget on its own.
      let budget: ChunkBudget | null = null
      let groupXmls: string[] | null = null
      if (variant.group && chunkMode !== 'shrink') {
        const resolved = proofreadBudget(call)
        if (
          resolved &&
          !(chunkMode === 'auto' && countTextTokens(payload) <= resolved.inputBudget)
        ) {
          budget = resolved
          groupXmls = variant.group(blocks, resolved)
        }
      }

      const run: ProofreadRun = { answer: '' }
      let meta: ProofreadMeta
      let chunks = 0

      if (groupXmls) {
        const r = await proofreadGroupXmls(groupXmls, call)
        run.merged = r.merged
        meta = r.meta
        chunks = groupXmls.length
      } else {
        const r = await runProofread(payload, expectedIds, call)
        run.answer = r.content
        meta = r.meta
      }

      const next: Envelope<string> = {
        ...env,
        item: variant.wrap(blocks, run),
        meta: { ...env.meta, [variant.metaKey]: meta },
      }
      if (chunks > 0 && budget && variant.chunksVariable) {
        return setVariable(next, variant.chunksVariable, toChunkRecord(budget, chunks))
      }
      return next
    },
  })
}

// ---------------------------------------------------------------------------
// Tool: proofread (plain text)
// ---------------------------------------------------------------------------

/**
 * Builds an LLM proofreading tool for plain text: the text is split into blank-line
 * paragraphs, sent to the LLM as XML, and rebuilt from the returned `<proofread>` blocks.
 * English by default; pass custom `systemPrompt`/`userPrompt` for other text kinds.
 */
export function createProofreadTool(
  options: ProofreadOptions & ProofreadChunkOptions = {},
): Tool<string, string> {
  return createProofreadVariantTool(
    {
      name: 'proofread',
      version: '1.1.0',
      mdDescription:
        'Proofreads plain text with an LLM through the OpenRouter proxy. Splits the text into ' +
        'paragraphs, sends XML to the model, and returns the corrected text. English by default; ' +
        'prompts are fully overridable. Supports shrink/chunk/auto modes.',
      annotations: proofreadAnnotations(
        'TL227',
        'proofread',
        'Proofreads plain text with paragraph-aware LLM prompts.',
      ),
      system: PROOFREAD_SYSTEM_PROMPT,
      user: PROOFREAD_USER_PROMPT,
      optionKey: 'proofread',
      prepare: (input) => {
        const blocks = input
          .split(/\n\s*\n/)
          .map((text) => text.trim())
          .filter((text) => text !== '')
          .map((text, index) => ({ id: index + 1, text }))
        return { blocks, payload: buildResultsXml(blocks.map((block) => block.text)) }
      },
      parseAnswer: parseProofreadAnswer,
      wrap: (blocks, run) =>
        proofreadParagraphs(
          blocks.map((block) => block.text),
          run.merged ?? toResultMap(parseProofreadAnswer(run.answer)),
        ).join('\n\n'),
      group: (blocks, budget) => {
        let start = 1
        return groupItemsToBudget({
          items: blocks.map((block) => block.text),
          budget,
          weigh: (group) => countTextTokens(buildResultsXml(group)),
          render: (group) => {
            const groupXml = buildResultsXml(group, start)
            start += group.length
            return groupXml
          },
        })
      },
      chunksVariable: 'proofreadChunks',
      metaKey: 'proofread',
    },
    options,
  )
}

/** Default proofreading tool: English text, bundled prompts. */
export const proofreadTool = createProofreadTool()

// ---------------------------------------------------------------------------
// Tool: proofread-xml (sub tool)
// ---------------------------------------------------------------------------

/**
 * Lower-level proofreading sub tool: the input is already the XML expected by the model
 * (`<results>` with `<id>` + `<text>`), and the output is the model's XML
 * (`<id>` + `<proofread>`) — handy when callers already hold paragraph XML.
 */
export function createProofreadXmlTool(
  options: ProofreadXmlOptions & ProofreadChunkOptions = {},
): Tool<string, string> {
  return createProofreadVariantTool(
    {
      name: 'proofread-xml',
      version: '1.1.0',
      mdDescription:
        'Lower-level proofreading sub tool. Accepts the paragraph XML expected by the proofreader ' +
        'and returns the raw `<proofread>` XML from the LLM. Supports chunk modes.',
      annotations: proofreadAnnotations(
        'TL228',
        'proofread-xml',
        'Proofreads raw paragraph XML and returns corrected XML.',
      ),
      system: PROOFREAD_SYSTEM_PROMPT,
      user: PROOFREAD_USER_PROMPT,
      optionKey: 'proofread',
      prepare: (input) => ({ blocks: parseResultBlocks(input, 'text'), payload: input }),
      parseAnswer: parseProofreadAnswer,
      wrap: (blocks, run) => {
        if (!run.merged) return run.answer
        const originalMap = toResultMap(blocks)
        const ordered = blocks.map(
          (block) => run.merged?.get(block.id) ?? originalMap.get(block.id) ?? '',
        )
        return buildResultsXml(proofreadParagraphs(ordered, run.merged), 1, 'proofread')
      },
      group: (blocks, budget) =>
        groupItemsToBudget({
          items: blocks.map(
            (block) =>
              `  <result>\n    <id>${block.id}</id>\n    <text>${escapeXml(block.text)}</text>\n  </result>`,
          ),
          budget,
          weigh: (group) => countTextTokens(wrapResults(group)),
          render: wrapResults,
        }),
      chunksVariable: 'proofreadXmlChunks',
      metaKey: 'proofreadXml',
    },
    options,
  )
}

/** Default XML proofreading sub tool. */
export const proofreadXmlTool = createProofreadXmlTool()

// ---------------------------------------------------------------------------
// Tool: proofread-properties (sub tool)
// ---------------------------------------------------------------------------

/**
 * Lower-level proofreading sub tool using Java properties format: input is one
 * `key=value` per line (key = id/line number, value = original text), output the same
 * keys with proofread values.
 */
export function createProofreadPropertiesTool(
  options: ProofreadOptions = {},
): Tool<string, string> {
  return createProofreadVariantTool(
    {
      name: 'proofread-properties',
      version: '1.0.0',
      mdDescription:
        'Lower-level proofreading sub tool using Java properties format. ' +
        'Accepts one key=value per line (key = id/line number, value = original text) ' +
        'and returns the same keys with proofread values.',
      annotations: proofreadAnnotations(
        'TL226',
        'proofread-properties',
        'Proofreads Java-properties formatted text.',
      ),
      system: PROOFREAD_PROPERTIES_SYSTEM_PROMPT,
      user: PROOFREAD_PROPERTIES_USER_PROMPT,
      optionKey: 'proofreadProperties',
      prepare: (input) => ({ blocks: parsePropertiesBlock(input), payload: input }),
      parseAnswer: (content) => parsePropertiesBlock(content),
      wrap: (blocks, run) => {
        const proofreadMap = toResultMap(parsePropertiesBlock(run.answer))
        const originalMap = toResultMap(blocks)
        return blocks
          .map((block) => {
            const value = proofreadMap.has(block.id)
              ? (proofreadMap.get(block.id) ?? '')
              : (originalMap.get(block.id) ?? '')
            return `${block.id}=${escapeProperties(value)}`
          })
          .join('\n')
      },
      metaKey: 'proofreadProperties',
    },
    options,
  )
}

/** Default properties proofreading sub tool. */
export const proofreadPropertiesTool = createProofreadPropertiesTool()
