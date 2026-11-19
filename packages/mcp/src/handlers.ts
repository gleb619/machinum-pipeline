import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  DiscoveredPipeline,
  Exchange,
  ExchangeInput,
  Logger,
  Pipeline,
  PipelineStep,
  RunContext,
  RunStateData,
  Tool,
  ToolContext,
} from '@mt/core'
import {
  Runner,
  Store,
  discoverPipelines,
  formatLogLine,
  importPipelineModule,
  loadGlobalContext,
  toExchange,
} from '@mt/core'

interface InitializeResult {
  protocolVersion: '2024-11-05'
  capabilities: {
    tools: { listChanged: false }
    resources: { listChanged: false }
  }
  serverInfo: {
    name: 'mt-mcp'
    version: '0.1.0'
  }
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

interface ResourceItem {
  uri: string
  name: string
  description: string
  mimeType?: string
}

interface ResourceReadResult {
  contents: Array<{
    uri: string
    mimeType: string
    text: string
  }>
}

/** A single JSON-schema property of a tool input schema. */
export interface ToolSchemaProperty {
  type: string
  description?: string
  items?: { type: string }
  additionalProperties?: boolean
}

/** JSON schema of a tool's arguments — always an object schema. */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

/** An MCP tool descriptor, as returned by `tools/list`. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

/** A pipeline discovered in the project — `file` is what `pipelines.run` accepts. */
export interface PipelineInfo {
  /** Pipeline path relative to the project root. */
  file: string
  /** The path exactly as declared in `mt.json`. */
  declared: string
  /** Absolute path of the pipeline module. */
  path: string
}

/** A run summary, as returned by `runs.list`. */
export interface RunInfo {
  runId: string
  status: string
  startedAt?: string
  updatedAt?: string
  pipelineId?: string
}

/** A tool implementation: its descriptor plus the handler behind it. */
interface ToolEntry {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, projectRoot: string) => Promise<unknown>
}

/**
 * Optional built-in tool package. The specifier lives in a constant because
 * `@mt/mcp` does not depend on `@mt/tools` — the import is resolved at runtime
 * and skipped when the package is not installed.
 */
const BUILTIN_TOOLS_PACKAGE = '@mt/tools'

/** A tool resolved from a declared pipeline or from the optional `@mt/tools` package. */
interface ToolMatch {
  tool: Tool<unknown, unknown>
  pipelineId: string
  pipelinePath?: string
}

/** Result of resolving a tool name; the miss case carries the hint data. */
interface ToolResolution {
  match?: ToolMatch
  available: string[]
  builtinNote?: string
}

/**
 * The MCP tool surface. Only the tools listed here are exposed —
 * `tools/list` and `tools/call` share this single registry.
 */
const TOOLS: Record<string, ToolEntry> = {
  'pipelines.list': {
    definition: {
      name: 'pipelines.list',
      description: 'List the pipelines declared in the project mt.json.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: listPipelines,
  },
  'pipelines.run': {
    definition: {
      name: 'pipelines.run',
      description: 'Start a pipeline run in the background and return its run id.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Pipeline file path, relative to the project root',
          },
          args: {
            type: 'object',
            description: 'Optional arguments handed to a pipeline factory export',
            additionalProperties: true,
          },
        },
        required: ['file'],
        additionalProperties: false,
      },
    },
    handler: runPipeline,
  },
  'runs.list': {
    definition: {
      name: 'runs.list',
      description: 'List the runs recorded under .mt/runs with their status.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: listRuns,
  },
  'runs.inspect': {
    definition: {
      name: 'runs.inspect',
      description: 'Return the full checkpoint tree and metadata of a run.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'Id of the run to inspect',
          },
        },
        required: ['runId'],
        additionalProperties: false,
      },
    },
    handler: inspectRun,
  },
  'tools.invoke': {
    definition: {
      name: 'tools.invoke',
      description: 'Invoke a processing tool directly with a partial Exchange envelope.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'Name of the tool to invoke',
          },
          envelope: {
            type: 'object',
            description: 'Partial Exchange — item is required; id, meta and variables are optional',
            additionalProperties: true,
          },
        },
        required: ['toolName', 'envelope'],
        additionalProperties: false,
      },
    },
    handler: invokeTool,
  },
}

export function handleInitialize(): InitializeResult {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
    },
    serverInfo: {
      name: 'mt-mcp',
      version: '0.1.0',
    },
  }
}

export function handleToolsList(): { tools: ToolDefinition[] } {
  return { tools: Object.values(TOOLS).map((entry) => entry.definition) }
}

/**
 * Dispatch a `tools/call` request to the tool named in `params`.
 *
 * `projectRoot` bounds every filesystem access; it defaults to `MT_PROJECT_ROOT`
 * and then to the current working directory.
 */
export async function handleToolsCall(
  params: { name: string; arguments?: Record<string, unknown> },
  projectRoot?: string,
): Promise<ToolCallResult> {
  const request = params as { name?: unknown; arguments?: unknown } | undefined
  const name = typeof request?.name === 'string' ? request.name : ''
  // Own-property lookup only: a name like 'constructor' must not reach Object.prototype.
  const entry = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
  if (!entry) {
    const known = Object.keys(TOOLS).join(', ')
    return errorResult(`Tool not found: ${name || '(no name given)'}. Known tools: ${known}`)
  }

  const args = request?.arguments
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return errorResult(`Invalid arguments for tool '${name}': expected a JSON object`)
  }

  try {
    const data = await entry.handler(
      (args ?? {}) as Record<string, unknown>,
      resolveProjectRoot(projectRoot),
    )
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

export async function handleResourcesList(
  projectRoot: string,
): Promise<{ resources: ResourceItem[] }> {
  const pipelines = await discoverPipelines(projectRoot)
  const resources: ResourceItem[] = pipelines.map((pipeline: DiscoveredPipeline) => ({
    uri: `mt://pipeline/${pipeline.path}`,
    name: pipeline.declared,
    description: '',
  }))

  return { resources }
}

export async function handleResourcesRead(params: { uri: string }): Promise<ResourceReadResult> {
  const uri = params.uri

  if (uri.startsWith('mt://pipeline/')) {
    const pipelinePath = uri.slice('mt://pipeline/'.length)
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ path: pipelinePath }),
        },
      ],
    }
  }

  if (uri.startsWith('mt://book/') || uri.startsWith('mt://chapter/')) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ message: 'Source integration deferred to v2' }),
        },
      ],
    }
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ error: 'Unknown URI scheme' }),
      },
    ],
  }
}

/** List the pipelines declared in the project's `mt.json`. */
async function listPipelines(
  _args: Record<string, unknown>,
  projectRoot: string,
): Promise<PipelineInfo[]> {
  const pipelines = await discoverPipelines(projectRoot)
  return pipelines.map((pipeline) => ({
    file: relative(projectRoot, pipeline.path),
    declared: pipeline.declared,
    path: pipeline.path,
  }))
}

/**
 * Background runs started by `pipelines.run` that have not settled yet.
 *
 * The MCP server speaks stdio: when the client disconnects, stdin hits EOF and
 * the server would exit, killing every in-flight run mid-step and leaving
 * `state.json` stuck at `running` with no process behind it. The server drains
 * this set before exiting, so a disconnected client never orphans a run.
 */
export const activeRuns = new Set<Promise<unknown>>()

/**
 * Start a pipeline run in the background.
 *
 * The run is fire-and-forget: the response carries the run id as soon as the
 * Runner minted it, so the caller never waits for the pipeline to finish.
 */
async function runPipeline(
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<{ runId: string }> {
  const file = args.file
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error("Invalid arguments for 'pipelines.run': 'file' must be a non-empty string")
  }
  const pipelineArgs = readOptionalArgs(args.args)
  const resolvedPath = resolveInsideRoot(projectRoot, file)

  const pipelineModule = await importPipelineModule(resolvedPath)
  const pipeline = resolvePipeline(pipelineModule, pipelineArgs, file)

  const globalContext = await loadGlobalContext(projectRoot)
  const runner = new Runner(pipeline, globalContext, {
    pipelineFile: relative(projectRoot, resolvedPath),
  })

  // start() mints the run id before its first await, so it is readable right away.
  const running = runner.start()
  const runId = runner.getRunId()
  // Attach the failure handler first: the tracked promise must never reject, or
  // the drain would turn a failed run into an unhandled rejection.
  const tracked = running.catch((error: unknown) => {
    console.error(`[mcp] Background run failed (runId: ${runId}):`, error)
  })
  // Track the run so the server can drain it when stdin closes.
  activeRuns.add(tracked)
  void tracked.finally(() => {
    activeRuns.delete(tracked)
  })

  if (!runId) {
    throw new Error(`Failed to start pipeline: ${file} (no run id was minted)`)
  }
  return { runId }
}

/** List the runs stored under `.mt/runs`. */
async function listRuns(_args: Record<string, unknown>, projectRoot: string): Promise<RunInfo[]> {
  const runsRoot = new Store(join(projectRoot, '.mt')).resolve('runs')

  let entries: Dirent[]
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch {
    // No .mt/runs yet — an empty list, not an error.
    return []
  }

  const runs: RunInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runStore = new Store(join(runsRoot, entry.name))
    try {
      const state = await runStore.readJson<Partial<RunStateData>>('state.json')
      runs.push({
        runId: state.runId ?? entry.name,
        status: state.state ?? 'unknown',
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        pipelineId: state.pipelineId,
      })
    } catch {
      // A run directory without a readable state.json is not a run — skip it.
    }
  }
  return runs
}

/** Return the full state (checkpoint tree + metadata) of a single run. */
async function inspectRun(
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<RunStateData> {
  const runId = args.runId
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error("Invalid arguments for 'runs.inspect': 'runId' must be a non-empty string")
  }
  assertSafeRunId(runId)

  const runStore = new Store(join(projectRoot, '.mt', 'runs', runId))
  if (!(await runStore.exists('state.json'))) {
    throw new Error(`Run not found: ${runId}`)
  }
  return runStore.readJson<RunStateData>('state.json')
}

/** True when the value looks like a Tool (name + invoke). */
function isTool(value: unknown): value is Tool<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; invoke?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.invoke === 'function'
}

/** Tools used by the tool steps of one pipeline. */
function toolsOf(pipeline: Pipeline): Tool<unknown, unknown>[] {
  const tools: Tool<unknown, unknown>[] = []
  for (const step of pipeline.steps as PipelineStep[]) {
    if (step.type !== 'tool') continue
    const tool = (step.config as { tool?: unknown }).tool
    if (isTool(tool)) tools.push(tool)
  }
  return tools
}

/** Scan the tool steps of every pipeline declared in `mt.json`. */
async function findDeclaredTools(
  projectRoot: string,
  name: string,
): Promise<{ matches: ToolMatch[]; names: Set<string> }> {
  const matches: ToolMatch[] = []
  const names = new Set<string>()
  for (const pipeline of await discoverPipelines(projectRoot)) {
    const mod = await importPipelineModule(pipeline.path)
    for (const value of Object.values(mod)) {
      if (!isPipeline(value)) continue
      for (const tool of toolsOf(value)) {
        names.add(tool.name)
        if (tool.name === name) {
          matches.push({ tool, pipelineId: value.id, pipelinePath: pipeline.path })
        }
      }
    }
  }
  return { matches, names }
}

/** Load the optional built-in tools; a missing package is a note, never a crash. */
async function importBuiltinTools(): Promise<{
  tools: Tool<unknown, unknown>[]
  note?: string
}> {
  try {
    const module = (await import(BUILTIN_TOOLS_PACKAGE)) as Record<string, unknown>
    const seen = new Set<unknown>()
    const tools: Tool<unknown, unknown>[] = []
    for (const value of Object.values(module)) {
      if (!isTool(value) || seen.has(value)) continue
      seen.add(value)
      tools.push(value)
    }
    return { tools }
  } catch (error) {
    return {
      tools: [],
      note: `built-in tools from @mt/tools are unavailable (${errorMessage(error)})`,
    }
  }
}

/**
 * Resolve a tool name: first the tool steps of pipelines declared in `mt.json`,
 * then the optional built-in `@mt/tools` exports. A name used by more than one
 * declared pipeline is ambiguous and rejected.
 */
async function resolveTool(projectRoot: string, name: string): Promise<ToolResolution> {
  const { matches, names } = await findDeclaredTools(projectRoot, name)
  if (matches.length > 1) {
    const sources = matches.map(
      (match) => `${match.pipelineId} (${match.pipelinePath ?? 'unknown path'})`,
    )
    throw new Error(
      `Tool '${name}' is ambiguous — used by multiple pipelines: ${sources.join(', ')}. Restrict the search to one pipeline by giving the tool a unique name, or invoke the owning pipeline with pipelines.run.`,
    )
  }
  if (matches[0]) return { match: matches[0], available: [...names].sort() }

  const builtin = await importBuiltinTools()
  for (const tool of builtin.tools) names.add(tool.name)
  const builtinMatch = builtin.tools.find((tool) => tool.name === name)
  return {
    match: builtinMatch ? { tool: builtinMatch, pipelineId: builtinMatch.name } : undefined,
    available: [...names].sort(),
    builtinNote: builtin.note,
  }
}

/** Normalize the `envelope` argument; `item` is required, the rest is optional. */
function readEnvelope(value: unknown): Exchange<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error("Invalid arguments for 'tools.invoke': 'envelope' must be an object")
  }
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'item') || record.item === undefined) {
    throw new Error("Invalid arguments for 'tools.invoke': 'envelope.item' is required")
  }
  if (record.id !== undefined && typeof record.id !== 'string') {
    throw new Error("Invalid arguments for 'tools.invoke': 'envelope.id' must be a string")
  }
  const meta = record.meta
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    throw new Error("Invalid arguments for 'tools.invoke': 'envelope.meta' must be an object")
  }
  if (record.variables !== undefined && !Array.isArray(record.variables)) {
    throw new Error("Invalid arguments for 'tools.invoke': 'envelope.variables' must be an array")
  }
  return toExchange(record as unknown as ExchangeInput<unknown>)
}

/** Invoke a processing tool directly, outside a pipeline run. */
async function invokeTool(
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<Exchange<unknown>> {
  const toolName = args.toolName
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    throw new Error("Invalid arguments for 'tools.invoke': 'toolName' must be a non-empty string")
  }
  const envelope = readEnvelope(args.envelope)
  const resolution = await resolveTool(projectRoot, toolName)
  if (!resolution.match) throw new Error(unknownToolMessage(toolName, resolution))
  return invokeResolvedTool(resolution.match, envelope, projectRoot)
}

/** Run one tool with the minimal standalone context used by `mt tool`. */
async function invokeResolvedTool(
  match: ToolMatch,
  envelope: Exchange<unknown>,
  projectRoot: string,
): Promise<Exchange<unknown>> {
  const globalContext = await loadGlobalContext(projectRoot)
  const runId = `mcp-${randomUUID()}`
  // MCP stdio reserves stdout for JSON-RPC: every log line goes to stderr.
  const logger: Logger = {
    info: (message, meta) => console.error(formatLogLine('info', message, meta)),
    warn: (message, meta) => console.error(formatLogLine('warn', message, meta)),
    error: (message, meta) => console.error(formatLogLine('error', message, meta)),
    debug: (message, meta) => {
      if (process.env.MT_DEBUG) console.error(formatLogLine('debug', message, meta))
    },
  }
  const runContext: RunContext = {
    runId,
    pipelineId: match.pipelineId,
    startedAt: new Date().toISOString(),
    global: globalContext,
    checkpoint: { stepId: 'standalone', depth: 0, path: ['standalone'] },
    logger,
    artifactsDir: join(projectRoot, '.mt', 'runs', runId, 'artifacts'),
  }
  const toolContext: ToolContext = {
    run: runContext,
    step: {
      stepId: `standalone/${match.tool.name}`,
      name: match.tool.name,
      type: 'tool',
      index: 0,
    },
  }

  try {
    return await match.tool.invoke(envelope, toolContext)
  } catch (error) {
    throw new Error(`Tool '${match.tool.name}' failed: ${errorMessage(error)}`)
  }
}

/** Message for a tool name that resolved neither in a pipeline nor in @mt/tools. */
function unknownToolMessage(name: string, resolution: ToolResolution): string {
  const lines = [`Unknown tool: ${name}`]
  if (resolution.available.length > 0) {
    lines.push(`Available tools: ${resolution.available.join(', ')}`)
  } else {
    lines.push(
      'No tools found in the declared pipelines (see mt.json pipelines[]) or in @mt/tools.',
    )
  }
  if (resolution.builtinNote) lines.push(`Note: ${resolution.builtinNote}`)
  return lines.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Build the MCP error payload: a single text block flagged as an error. */
function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Project root of the server: explicit argument, then `MT_PROJECT_ROOT`, then cwd. */
function resolveProjectRoot(projectRoot?: string): string {
  if (projectRoot && projectRoot.trim() !== '') return resolve(projectRoot)
  const fromEnv = process.env.MT_PROJECT_ROOT
  return resolve(fromEnv && fromEnv.trim() !== '' ? fromEnv : process.cwd())
}

/**
 * Resolve `requested` against `root`, keeping the result inside `root`.
 * Absolute paths and `..` segments are rejected outright — a tool argument
 * must never reach outside the project it was called for.
 */
function resolveInsideRoot(root: string, requested: string): string {
  if (isAbsolute(requested)) {
    throw new Error(`Absolute paths are not allowed: ${requested}`)
  }
  if (requested.split(/[\\/]/).includes('..')) {
    throw new Error(`Path traversal is not allowed: ${requested}`)
  }

  const base = resolve(root)
  const target = resolve(base, requested)
  const rel = relative(base, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path outside project root: ${requested}`)
  }
  return target
}

/** A run id must be a single directory name inside `.mt/runs`. */
function assertSafeRunId(runId: string): void {
  const separators = ['/', '\\', delimiter]
  if (runId.includes('..') || separators.some((separator) => runId.includes(separator))) {
    throw new Error(`Invalid runId: ${runId}`)
  }
}

/** Validate the optional `args` object of `pipelines.run`. */
function readOptionalArgs(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error("Invalid arguments for 'pipelines.run': 'args' must be an object")
  }
  return value as Record<string, unknown>
}

/**
 * Pick the pipeline out of a loaded module.
 *
 * A default export that is a function is treated as a factory and called with
 * the run arguments; any other export is used as the pipeline itself.
 */
function resolvePipeline(
  pipelineModule: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
  file: string,
): Pipeline {
  const exported = pipelineModule.default ?? pipelineModule.pipeline
  const candidate =
    typeof exported === 'function'
      ? (exported as (runArgs: Record<string, unknown>) => unknown)(args ?? {})
      : exported

  if (!isPipeline(candidate)) {
    throw new Error(
      `Invalid pipeline module: ${file} (expected a default export created by definePipeline())`,
    )
  }
  return candidate
}

/** True when the value looks like a `Pipeline` (has an id and a step list). */
function isPipeline(value: unknown): value is Pipeline {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; steps?: unknown }
  return typeof candidate.id === 'string' && Array.isArray(candidate.steps)
}
