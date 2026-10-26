import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DiscoveredPipeline, Pipeline, RunStateData } from '@mt/core'
import { Runner, Store, discoverPipelines, importPipelineModule, loadGlobalContext } from '@mt/core'

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
  running.catch((error: unknown) => {
    console.error(`[mcp] Background run failed (runId: ${runId}):`, error)
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
