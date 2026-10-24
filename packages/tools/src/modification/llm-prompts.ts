import { isAbsolute, resolve } from 'node:path'
import type { ToolContext } from '@mt/core'
import { readTextFileSync } from '../normalization/fs-read.js'
import { readCtx } from './llm-config.js'

/** A named prompt template using `{{var}}` placeholders. */
export interface PromptTemplate {
  name: string
  template: string
  description?: string
}

export class PromptVariableError extends Error {
  constructor(
    readonly promptName: string,
    readonly missing: string[],
  ) {
    super(
      `Prompt '${promptName}' is missing variable(s): ${missing.join(', ')}. Provide them in vars (placeholders look like {{name}}).`,
    )
    this.name = 'PromptVariableError'
  }
}

export class PromptNotFoundError extends Error {
  constructor(readonly promptName: string) {
    super(
      `Unknown prompt '${promptName}'. Registered: ${listPrompts()
        .map((p) => p.name)
        .join(', ')}`,
    )
    this.name = 'PromptNotFoundError'
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Names of `{{var}}` placeholders in a template. */
export function templateVars(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))]
}

/** Interpolate `{{var}}`. Missing (undefined/null) vars throw `PromptVariableError`. */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown> = {},
  name = 'inline',
): string {
  const missing = templateVars(template).filter((v) => vars[v] === undefined || vars[v] === null)
  if (missing.length > 0) throw new PromptVariableError(name, missing)
  return template.replace(PLACEHOLDER, (_, v: string) => stringify(vars[v]))
}

// ---------------------------------------------------------------------------
// Registry of defaults
// ---------------------------------------------------------------------------

const registry = new Map<string, PromptTemplate>()

export function registerPrompt(prompt: PromptTemplate): void {
  registry.set(prompt.name, prompt)
}

export function getDefaultPrompt(name: string): PromptTemplate | undefined {
  return registry.get(name)
}

export function listPrompts(): PromptTemplate[] {
  return [...registry.values()]
}

const DEFAULTS: PromptTemplate[] = [
  {
    name: 'translate.system',
    description: 'System prompt for translation.',
    template:
      'You are a professional literary translator. Translate from {{sourceLang}} to {{targetLang}}. ' +
      'Preserve markdown, names and paragraph structure. Output only the translation.',
  },
  {
    name: 'translate.user',
    description: 'User prompt for translation.',
    template: '{{text}}',
  },
  {
    name: 'summary',
    description: 'Chapter summary.',
    template: 'Summarize the following text in {{sentences}} sentences.\n\n{{text}}',
  },
  {
    name: 'entities',
    description: 'Named entity extraction.',
    template:
      'Extract named entities (characters, places, items) from the text. ' +
      'Return a JSON array of {"name": string, "type": string}.\n\n{{text}}',
  },
  {
    name: 'context.summarize',
    description: 'Used by the `summarize` shrink strategy to compress old messages.',
    template:
      'Summarize the following conversation excerpt in at most {{maxWords}} words. ' +
      'Keep facts, names, decisions and open questions.\n\n{{transcript}}',
  },
  {
    name: 'json.correction',
    description: 'Corrective user message after an unparseable JSON answer.',
    template:
      'Your previous answer was not valid JSON ({{error}}). ' +
      'Reply again with only the corrected JSON value, no prose, no code fences.',
  },
]
for (const p of DEFAULTS) registerPrompt(p)

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PromptSources {
  /** Tool factory option: `{ [name]: template | '@file' }`. */
  tool?: Record<string, string>
  /** Envelope meta; reads `meta.prompts[name]`. */
  meta?: Record<string, unknown>
  /** mt.json settings; reads flat key `prompts.<name>`. */
  settings?: Record<string, unknown>
  /** Base dir for relative `@file` paths. Default: cwd. */
  baseDir?: string
  /** File reader (tests). Default: fs.readFileSync utf8. */
  readFile?: (path: string) => string
}

export type PromptSource = 'tool' | 'meta' | 'settings' | 'env' | 'default'

/** `translate.system` -> `MT_PROMPT_TRANSLATE_SYSTEM`. */
export function promptEnvName(name: string): string {
  return `MT_PROMPT_${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

function load(value: string, sources: PromptSources, promptName: string, origin: string): string {
  if (!value.startsWith('@')) return value
  const rel = value.slice(1)
  const path = isAbsolute(rel) ? rel : resolve(sources.baseDir ?? process.cwd(), rel)
  try {
    return (sources.readFile ?? ((p: string) => readTextFileSync(p)))(path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Prompt '${promptName}' (${origin}) could not read file ${path}: ${msg}`)
  }
}

/**
 * Pick the template text. Precedence: tool option > `meta.prompts[name]` > settings `prompts.<name>`
 * > env `MT_PROMPT_<NAME>` > registered default. Values starting with `@` are file paths.
 */
export function resolvePromptTemplate(
  name: string,
  sources: PromptSources = {},
  env: Record<string, string | undefined> = process.env,
): { template: string; source: PromptSource } {
  const metaPrompts = sources.meta?.prompts as Record<string, unknown> | undefined
  const candidates: Array<[PromptSource, unknown]> = [
    ['tool', sources.tool?.[name]],
    ['meta', metaPrompts?.[name]],
    ['settings', sources.settings?.[`prompts.${name}`]],
    ['env', env[promptEnvName(name)]],
  ]
  for (const [source, v] of candidates) {
    if (typeof v === 'string' && v.length > 0) {
      return { template: load(v, sources, name, source), source }
    }
  }
  const def = registry.get(name)
  if (!def) throw new PromptNotFoundError(name)
  return { template: def.template, source: 'default' }
}

/** Resolve + render a named prompt. Missing vars throw `PromptVariableError`. */
export function resolvePrompt(
  name: string,
  vars: Record<string, unknown> = {},
  sources: PromptSources = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const { template } = resolvePromptTemplate(name, sources, env)
  return renderTemplate(template, vars, name)
}

/** Build `PromptSources` from a tool context (settings, project root as baseDir). */
export function promptSourcesFromCtx(
  ctx: ToolContext | undefined,
  parts: { tool?: Record<string, string>; meta?: Record<string, unknown> } = {},
): { sources: PromptSources; env: Record<string, string | undefined> } {
  const v = readCtx(ctx)
  return {
    sources: { ...parts, settings: v.settings, baseDir: v.projectRoot },
    env: v.env,
  }
}
