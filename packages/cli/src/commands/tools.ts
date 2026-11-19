import { readFileSync } from 'node:fs'
import { annotate, annotationsOf, toExchange, useCase, variable, withVariable } from '@mt/core'
import type { Exchange, ExchangeInput, ExchangeMeta, Tool } from '@mt/core'
import { findTool, listToolMatches } from '../utils/find-tool.js'
import type { ToolMatch } from '../utils/find-tool.js'
import { createStandaloneToolContext } from './utils/standalone-tool-context.js'

/**
 * `mt tools list|call` — the callable tool catalogue and single-tool invocation.
 *
 * `list` merges the tools declared by the project's pipelines with the built-ins of
 * `@mt/tools` (resolved lazily: the package is optional, a missing one only skips that
 * source). `call` invokes one tool standalone, with the same minimal context `mt tool`
 * builds.
 */

/** One catalogue row. `source` is `builtin` or the id of the pipeline declaring the tool. */
export interface ToolCatalogueEntry {
  name: string
  source: string
  category: string | null
  description: string | null
  /** Ids of the pipelines that use the tool (empty for a built-in nobody uses). */
  usedBy: string[]
}

interface BuiltinTool {
  tool: Tool<unknown, unknown>
  category: string | null
  description: string | null
}

interface BuiltinTools {
  tools: BuiltinTool[]
  warning: string | null
}

/** True when the value looks like a Tool (name + invoke). */
function isTool(value: unknown): value is Tool<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; invoke?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.invoke === 'function'
}

/** Categories of a tool, from its `category([...])` annotation (comma separated). */
function categoryOf(tool: Tool<unknown, unknown>): string | null {
  const annotation = annotationsOf(tool).find((entry) => entry.kind === 'category')
  if (!annotation || annotation.kind !== 'category') return null
  return annotation.categories.length > 0 ? annotation.categories.join(', ') : null
}

/** Description of a tool: the `tool(...)` annotation wins over `mdDescription`. */
function descriptionOf(tool: Tool<unknown, unknown>): string | null {
  const annotation = annotationsOf(tool).find((entry) => entry.kind === 'tool')
  if (annotation && 'description' in annotation && annotation.description) {
    return annotation.description
  }
  return tool.mdDescription || null
}

/**
 * Built-in tools of `@mt/tools`. The package is imported lazily (the CLI must start
 * without it); a missing package only skips the built-in source.
 */
async function loadBuiltinTools(): Promise<BuiltinTools> {
  let exports: Record<string, unknown>
  try {
    exports = (await import('@mt/tools')) as unknown as Record<string, unknown>
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      tools: [],
      warning: `Warning: @mt/tools is not available (${reason}) — built-in tools are skipped.`,
    }
  }
  const tools: BuiltinTool[] = []
  const seen = new Set<string>()
  for (const value of Object.values(exports)) {
    if (!isTool(value) || seen.has(value.name)) continue
    seen.add(value.name)
    tools.push({ tool: value, category: categoryOf(value), description: descriptionOf(value) })
  }
  return { tools, warning: null }
}

/** Catalogue of the callable tools: built-ins plus the tools of the declared pipelines. */
async function buildCatalogue(
  projectRoot: string,
  pipelineFile?: string,
): Promise<{ entries: ToolCatalogueEntry[]; warnings: string[] }> {
  const builtins = await loadBuiltinTools()
  const warnings = builtins.warning ? [builtins.warning] : []

  let matches: ToolMatch[] = []
  try {
    matches = await listToolMatches(projectRoot, pipelineFile)
  } catch (error) {
    warnings.push(
      `Warning: pipeline scan failed — ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const byName = new Map<string, ToolCatalogueEntry>()
  for (const builtin of builtins.tools) {
    byName.set(builtin.tool.name, {
      name: builtin.tool.name,
      source: 'builtin',
      category: builtin.category,
      description: builtin.description,
      usedBy: [],
    })
  }
  for (const match of matches) {
    const existing = byName.get(match.tool.name)
    if (existing) {
      // A built-in wins the row; the pipeline usage moves into `usedBy`.
      if (!existing.usedBy.includes(match.pipelineId)) existing.usedBy.push(match.pipelineId)
      continue
    }
    byName.set(match.tool.name, {
      name: match.tool.name,
      source: match.pipelineId,
      category: categoryOf(match.tool),
      description: descriptionOf(match.tool),
      usedBy: [match.pipelineId],
    })
  }

  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) entry.usedBy.sort((a, b) => a.localeCompare(b))
  return { entries, warnings }
}

function cell(value: string | null): string {
  if (!value) return '—'
  return value.replaceAll('|', '\\|').replace(/\r\n?|\n/g, '<br>')
}

function renderMarkdown(entries: readonly ToolCatalogueEntry[]): string {
  const lines = [
    '# Tool catalogue',
    '',
    `${entries.length} tool${entries.length === 1 ? '' : 's'}.`,
    '',
    '| Name | Source | Category | Description |',
    '| --- | --- | --- | --- |',
  ]
  for (const entry of entries) {
    lines.push(
      `| ${cell(entry.name)} | ${cell(entry.source)} | ${cell(entry.category)} | ${cell(entry.description)} |`,
    )
  }
  return lines.join('\n')
}

async function listCommand(args: string[]): Promise<void> {
  let json = false
  let pipelineFile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--pipeline') {
      const value = args[i + 1]
      if (!value) {
        console.error('Error: --pipeline requires a file argument')
        process.exit(1)
      }
      pipelineFile = value
      i++
      continue
    }
    console.error(`Error: Unknown option for mt tools list: ${arg}`)
    usage()
  }

  const { entries, warnings } = await buildCatalogue(process.cwd(), pipelineFile)
  for (const warning of warnings) console.error(warning)
  console.log(
    json ? JSON.stringify({ schemaVersion: 1, tools: entries }, null, 2) : renderMarkdown(entries),
  )
}

interface CallArgs {
  name: string
  pipelineFile?: string
  item?: string
  meta?: string
  vars: string[]
  json: boolean
}

function parseCallArgs(args: string[]): CallArgs {
  const name = args[0]
  if (!name) {
    console.error('Error: mt tools call requires a tool name')
    usage()
  }
  const parsed: CallArgs = { name, vars: [], json: false }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--pipeline' || arg === '--item' || arg === '--meta' || arg === '--var') {
      const value = args[i + 1]
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`)
        process.exit(1)
      }
      i++
      if (arg === '--pipeline') parsed.pipelineFile = value
      else if (arg === '--item') parsed.item = value
      else if (arg === '--meta') parsed.meta = value
      else parsed.vars.push(value)
      continue
    }
    console.error(`Error: Unknown option for mt tools call: ${arg}`)
    usage()
  }
  return parsed
}

/** `--item` value: JSON when it parses, the raw string otherwise. */
function parseItem(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** `--meta` value: a JSON object. */
function parseMeta(raw: string): ExchangeMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(
      `Error: --meta is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('Error: --meta must be a JSON object')
    process.exit(1)
  }
  return parsed as ExchangeMeta
}

/** `--var k=v` pairs. */
function parseVars(raws: readonly string[]): [string, string][] {
  const vars: [string, string][] = []
  for (const raw of raws) {
    const separator = raw.indexOf('=')
    if (separator <= 0) {
      console.error(`Error: --var expects name=value, got '${raw}'`)
      process.exit(1)
    }
    vars.push([raw.slice(0, separator), raw.slice(separator + 1)])
  }
  return vars
}

/** stdin content, empty when stdin is a TTY or unreadable. */
function readStdin(): string {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8').trim()
  } catch {
    return ''
  }
}

async function callCommand(args: string[]): Promise<void> {
  const parsed = parseCallArgs(args)
  const projectRoot = process.cwd()

  let match: ToolMatch | undefined
  try {
    match = await findTool(projectRoot, parsed.name, parsed.pipelineFile)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  let tool: Tool<unknown, unknown> | undefined = match?.tool
  const pipelineId = match?.pipelineId ?? 'builtin'
  const builtins = await loadBuiltinTools()
  if (builtins.warning) console.error(builtins.warning)
  if (!tool) {
    const fallback = builtins.tools.find((entry) => entry.tool.name === parsed.name)
    if (fallback) tool = fallback.tool
  }

  if (!tool) {
    const available = new Set<string>()
    for (const entry of builtins.tools) available.add(entry.tool.name)
    try {
      for (const pipelineMatch of await listToolMatches(projectRoot, parsed.pipelineFile)) {
        available.add(pipelineMatch.tool.name)
      }
    } catch {
      // A broken pipeline file must not hide the available built-ins.
    }
    console.error(`Unknown tool: ${parsed.name}`)
    console.error(
      available.size > 0
        ? `Available tools: ${[...available].sort().join(', ')}`
        : 'No tools found (declare one in a pipeline or install @mt/tools).',
    )
    process.exit(1)
  }

  const stdinText = readStdin()
  let envelope: Exchange<unknown>
  if (stdinText !== '') {
    try {
      envelope = toExchange(JSON.parse(stdinText) as ExchangeInput<unknown>)
    } catch (error) {
      console.error(
        `Error: invalid JSON on stdin: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  } else {
    if (parsed.item === undefined) {
      console.error(
        'Usage: mt tools call <name> [--item <string|json>] [--meta <json>] [--var k=v]',
      )
      console.error(
        `Pipe a JSON exchange on stdin, e.g.: echo '{"item":"x","meta":{}}' | mt tools call ${parsed.name}`,
      )
      process.exit(1)
    }
    envelope = toExchange({ item: parseItem(parsed.item) })
  }

  if (parsed.meta !== undefined) {
    envelope = { ...envelope, meta: { ...envelope.meta, ...parseMeta(parsed.meta) } }
  }
  for (const [name, value] of parseVars(parsed.vars)) {
    envelope = withVariable(envelope, variable(name, value))
  }

  const { toolContext } = await createStandaloneToolContext({
    projectRoot,
    toolName: tool.name,
    pipelineId,
  })

  try {
    const output = await tool.invoke(envelope, toolContext)
    if (parsed.json) {
      console.log(JSON.stringify(output, null, 2))
      return
    }
    if (typeof output.item === 'string') {
      console.log(output.item)
      return
    }
    console.log(JSON.stringify(output.item ?? null, null, 2))
  } catch (error) {
    console.error(
      `Error: tool '${tool.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

/**
 * `mt tools <list|call>` — catalogue of the callable tools and standalone invocation
 * of one of them.
 */
export async function toolsCommand(args: string[]): Promise<void> {
  const subcommand = args[0]
  if (!subcommand) usage()
  switch (subcommand) {
    case 'list':
      await listCommand(args.slice(1))
      return
    case 'call':
      await callCommand(args.slice(1))
      return
    default:
      console.error(`Error: Unknown subcommand for mt tools: ${subcommand}`)
      usage()
  }
}

annotate(
  toolsCommand,
  useCase('UC083', {
    name: 'Browse the tool catalogue and invoke one tool',
    description:
      'List the callable tools (built-ins of @mt/tools plus the tools of the declared pipelines) and invoke one of them standalone.',
  }),
)

function usage(): never {
  console.error('Usage: mt tools <list|call> [options]')
  console.error('')
  console.error('Commands:')
  console.error('  list [--json] [--pipeline <file>]   Catalogue of the callable tools')
  console.error(
    '  call <name> [--pipeline <file>] [--item <string|json>] [--meta <json>] [--var k=v] [--json]',
  )
  console.error('                                       Invoke one tool standalone')
  console.error('')
  console.error('Options:')
  console.error('  --pipeline <file>       Restrict the pipeline scan to one file')
  console.error('  --item <string|json>    Input payload (JSON when it parses)')
  console.error('  --meta <json>           Meta object of the input exchange')
  console.error('  --var k=v               Variable of the input exchange (repeatable)')
  console.error('  --json                  Machine-readable output')
  process.exit(1)
}
