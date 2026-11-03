import { relative, resolve } from 'node:path'
import { format } from 'node:util'
import {
  DEFAULT_MT_CONFIG,
  isPipelineSuite,
  readMtConfig,
  registry,
  resolveRetryPolicy,
} from '@mt/core'
import type {
  ErrorPolicy,
  MtConfig,
  PartialRetryPolicy,
  Pipeline,
  PipelineStep,
  PipelineSuite,
  RetryPolicy,
  Settings,
  Source,
  Splitter,
  Target,
  Tool,
} from '@mt/core'
import { loadRunnable } from './run.js'

/**
 * `mt explain <pipeline.ts>` — describe the declared dataflow without running it.
 *
 * The pipeline module is imported (top-level module code runs, exactly like
 * `mt run`), but no Runner/source/tool/target/lifecycle hook is started and no
 * `.mt/runs/<runId>/` directory is created.
 *
 * Usage: mt explain <pipeline.ts> [--pipeline <name>] [--json]
 */

export interface ExplainOptions {
  /** Machine-readable JSON instead of Markdown. */
  json?: boolean
}

export interface ExplainedStep {
  index: number
  type: PipelineStep['type']
  /** Human-readable name: tool/splitter name or the declared fork/batch name. */
  name?: string
  /** Name token used by Runner.nextStepId: `config.name ?? step.type`. */
  stepIdName: string
  /** Runtime step id template. `<seq>` is assigned by the Runner at run time. */
  stepIdPattern: string
  /** Runtime `step-done` event/log id template, when the step emits one. */
  eventStepId?: string
  /** Checkpoint node template for nested steps (fork/subflow/batch scope). */
  checkpointNode?: string
  description: string
  cardinality: string
  /** Present on tool steps: effective merged retry policy. */
  retry?: RetryPolicy
  /** Present on tool steps: effective merged error policy. */
  onError?: ErrorPolicy
  /** Present on valid tool steps: effective Runner.runTool concurrency. */
  concurrency?: number
  cacheable?: boolean
  idempotent?: boolean
  uri?: string
  /** Original `@alias` when the URI came from `mt.json` -> `uris`. */
  alias?: string
  aliasError?: string
  /** Present on source steps with a Source instance. */
  sourceLifestyle?: string
  /** Present on source steps with a Source instance; true when it implements resume(). */
  sourceResumable?: boolean
  /** Present on target steps with a Target instance; true when it implements checkpoint(). */
  targetDurableCheckpoint?: boolean
  /** Present on split steps: the splitter lookup key (`paragraphs://`, `#lines`, ...). */
  splitterType?: string
  /** Nested pipelines (fork/subflow/batch scope). */
  nested?: ExplainedPipeline[]
}

export interface ExplainedPipeline {
  id: string
  retry: RetryPolicy
  onError: ErrorPolicy
  /** Declared pipeline-scoped env defaults from defineProcess().config({ env }). */
  envDefaults?: Record<string, string>
  stepCount: number
  steps: ExplainedStep[]
}

export interface ExplainedRunnable {
  kind: 'pipeline' | 'suite'
  id: string
  pipelineCount: number
  mode?: 'sync' | 'parallel'
  pipelines: ExplainedPipeline[]
}

export interface ExplainedRuntime {
  note: string
  runDir: string
  cacheDir: string
  files: Record<string, string>
  eventOrder: string[]
  states: string[]
  stateMachineNote: string
  eventTypes: string[]
  hooks: Record<string, string | undefined>
}

export interface PipelineExplanation {
  schemaVersion: 1
  command: 'mt explain'
  file: string
  project: { name: string; root: string }
  /** Declared mt.json LLM fallback; environment variables override it at run time. */
  llm?: {
    tool?: string
    model?: string
    note: string
  }
  defaults: {
    retry: RetryPolicy
    onError: ErrorPolicy
    concurrency: number
  }
  defaultsNote: string
  runnable: ExplainedRunnable
  runtime: ExplainedRuntime
  warnings: string[]
}

/** Parse and validate `mt explain` arguments. */
export function parseExplainArgs(args: string[]): {
  pipelineFile?: string
  pipelineName?: string
  options: ExplainOptions
  help: boolean
} {
  let pipelineFile: string | undefined
  let pipelineName: string | undefined
  let json = false
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--pipeline') {
      const value = args[++i]
      if (!value || value.startsWith('-')) {
        throw new Error('--pipeline requires a named export')
      }
      pipelineName = value
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (pipelineFile) throw new Error(`Unexpected argument: ${arg}`)
    pipelineFile = arg
  }

  return { pipelineFile, pipelineName, options: { json }, help }
}

export async function explainCommand(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseExplainArgs>
  try {
    parsed = parseExplainArgs(args)
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Usage: mt explain <pipeline.ts> [--pipeline <name>] [--json]')
    process.exit(1)
    return
  }

  if (parsed.help) {
    printExplainHelp()
    return
  }
  if (!parsed.pipelineFile) {
    console.error('Error: a pipeline file is required')
    console.error('Usage: mt explain <pipeline.ts> [--pipeline <name>] [--json]')
    console.error('  Describe the declared dataflow without executing sources, tools or targets')
    process.exit(1)
    return
  }

  try {
    const explanation = await buildExplanation(
      parsed.pipelineFile,
      parsed.pipelineName,
      process.cwd(),
    )
    if (parsed.options.json) {
      console.log(JSON.stringify(explanation, null, 2))
    } else {
      console.log(renderExplanation(explanation))
    }
  } catch (error) {
    console.error(
      `Error explaining pipeline: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

function printExplainHelp(): void {
  console.log(`Usage: mt explain <pipeline.ts> [--pipeline <name>] [--json]

Describe how a declared pipeline will flow without executing it.

Options:
  --pipeline <name>  Select a named export (pipeline or suite)
  --json             Emit a machine-readable explanation
  -h, --help         Show this help

The module is imported (top-level code runs), but no Runner, source, tool, target
or lifecycle hook is started. No run id or .mt/runs/<runId>/ directory is created.`)
}

/** Build the explanation model for one pipeline file. */
export async function buildExplanation(
  pipelineFile: string,
  pipelineName: string | undefined,
  projectRoot: string,
): Promise<PipelineExplanation> {
  return captureStdoutToStderr(() =>
    buildExplanationUncaptured(pipelineFile, pipelineName, projectRoot),
  )
}

async function buildExplanationUncaptured(
  pipelineFile: string,
  pipelineName: string | undefined,
  projectRoot: string,
): Promise<PipelineExplanation> {
  const runnable = await loadRunnable(resolve(projectRoot, pipelineFile), pipelineName)
  const config = await readMtConfig(projectRoot)
  const settings = settingsOf(config)
  const defaults = effectiveDefaults(config)
  const warnings: string[] = []

  const explained: ExplainedRunnable = isPipelineSuite(runnable)
    ? {
        kind: 'suite',
        id: runnable.id,
        pipelineCount: runnable.pipelines.length,
        mode: runnable.mode,
        pipelines: runnable.pipelines.map((pipeline) =>
          explainPipeline(pipeline, settings, defaults, warnings),
        ),
      }
    : {
        kind: 'pipeline',
        id: runnable.id,
        pipelineCount: 1,
        pipelines: [explainPipeline(runnable, settings, defaults, warnings)],
      }

  warnings.push(...duplicatePipelineIdWarnings(runnable))

  return {
    schemaVersion: 1,
    command: 'mt explain',
    file: relative(projectRoot, resolve(projectRoot, pipelineFile)),
    project: {
      name: config.project?.name ?? DEFAULT_MT_CONFIG.project.name,
      root: projectRoot,
    },
    llm: declaredLlm(settings),
    defaults,
    defaultsNote:
      'Lowest-priority fallbacks only: definePipeline() always supplies its own retry/onError, and step overrides win. Use each step policy for the effective value.',
    runnable: explained,
    runtime: {
      note: 'Explain only: no run id, state, logs, artifacts or cache entries are created.',
      runDir: '.mt/runs/<runId>/',
      cacheDir: '.mt/cache/<hash>.json',
      files: {
        'state.json': 'run state, checkpoint tree and source cursors (resume source of truth)',
        'context.json': 'frozen run context',
        'events.jsonl':
          'append-only run events; one JSON line per event: { type, ts, runId, stepId?, error? }',
        'run.log':
          'CLI lifecycle lines written by the DuplexLogger; a suite child run may have none (step logs still exist)',
        'logs/<stepId>.log':
          'engine, tool, source and target logs per step; every character outside [A-Za-z0-9._-] in the step id becomes "_"',
        'dead-letter.jsonl': 'failed exchanges; only when onError = dead-letter',
        'artifacts/': 'tool/target intermediate outputs',
      },
      eventOrder: [
        'run-level events: state.json + context.json write → events.jsonl append → in-process listeners',
        'step-done: events.jsonl append → in-process listeners; the checkpoint persist is scheduled/coalesced',
      ],
      states: ['pending', 'running', 'paused', 'resumed', 'done', 'failed'],
      stateMachineNote:
        '`checkpoint` is a valid transition target but the current Runner never enters it.',
      eventTypes: ['started', 'step-done', 'paused', 'resumed', 'done', 'failed'],
      hooks: {
        start: config.scripts?.start,
        end: config.scripts?.end,
        error: config.scripts?.error,
        stop: config.scripts?.stop,
        exit: config.scripts?.exit,
      },
    },
    warnings,
  }
}

/**
 * Keep stdout clean for `--json`: pipeline modules run their top-level code on import, so any
 * `console.log`/`process.stdout.write` output is captured here and replayed on stderr.
 */
async function captureStdoutToStderr<T>(run: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write
  const consoleMethods = ['log', 'info', 'debug'] as const
  const originalConsole = consoleMethods.map((name) => [name, console[name]] as const)
  let captured = ''
  let patchedWrite = false

  try {
    process.stdout.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      if (typeof chunk === 'string') captured += chunk
      else {
        const encodingName = typeof encoding === 'string' ? encoding : 'utf8'
        captured += Buffer.from(chunk).toString(encodingName)
      }
      const done = typeof encoding === 'function' ? encoding : callback
      done?.(null)
      return true
    }) as typeof process.stdout.write
    patchedWrite = process.stdout.write !== originalWrite
  } catch {
    // Some runtimes expose stdout.write as a non-writable native binding; the console
    // patch below is enough there.
    patchedWrite = false
  }

  // Some test runners replace console.log with a custom stream that bypasses
  // process.stdout.write; capture those methods explicitly too.
  for (const name of consoleMethods) {
    console[name] = (...args: unknown[]): void => {
      captured += `${format(...args)}\n`
    }
  }

  try {
    return await run()
  } finally {
    if (patchedWrite) {
      try {
        process.stdout.write = originalWrite
      } catch {
        // nothing to restore on runtimes that refused the patch
      }
    }
    for (const [name, method] of originalConsole) console[name] = method
    if (captured.length > 0) process.stderr.write(captured)
  }
}

interface EffectiveDefaults {
  retry: RetryPolicy
  onError: ErrorPolicy
  concurrency: number
}

function settingsOf(config: Partial<MtConfig>): Settings {
  const settings: Settings = { ...(config.settings ?? {}) }
  if (config.uris) settings.uris = config.uris
  return settings
}

function declaredLlm(settings: Settings): NonNullable<PipelineExplanation['llm']> {
  const tool = declaredSetting(settings['llm.tool'])
  const model = declaredSetting(settings['llm.model'])
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(model !== undefined ? { model } : {}),
    note: 'Declared mt.json values only. Env MT_LLM_TOOL / MT_LLM_MODEL override them at run time; an unset tool falls back to `mock`.',
  }
}

function declaredSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function effectiveDefaults(config: Partial<MtConfig>): EffectiveDefaults {
  const base = DEFAULT_MT_CONFIG.defaults
  return {
    retry: resolveRetryPolicy(undefined, undefined, withDefaultRetry(config.defaults?.retry)),
    onError: config.defaults?.onError ?? base.onError,
    concurrency: resolveConcurrency(config.defaults?.concurrency),
  }
}

/**
 * Mirror `loadGlobalContext()` without loading `.env` or the vault: `resolveRetry`
 * fills every unset field from DEFAULT_MT_CONFIG before `resolveRetryPolicy` validates.
 */
function withDefaultRetry(retry: PartialRetryPolicy | undefined): PartialRetryPolicy {
  const base = DEFAULT_MT_CONFIG.defaults.retry
  return {
    max: retry?.max ?? base.max,
    backoffMs: retry?.backoffMs ?? base.backoffMs,
    strategy: retry?.strategy ?? base.strategy,
    ...(retry?.maxBackoffMs !== undefined ? { maxBackoffMs: retry.maxBackoffMs } : {}),
  }
}

/** Same validation `loadGlobalContext()` applies to `defaults.concurrency`. */
function resolveConcurrency(value: number | undefined): number {
  const base = DEFAULT_MT_CONFIG.defaults.concurrency
  if (value === undefined) return base
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `Invalid mt.json: defaults.concurrency must be a positive integer, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

function explainPipeline(
  pipeline: Pipeline,
  settings: Settings,
  defaults: EffectiveDefaults,
  warnings: string[],
): ExplainedPipeline {
  if (!Array.isArray(pipeline.steps)) {
    warnings.push(
      `Pipeline '${pipeline.id}' has no steps array (legacy id-only pipeline); nothing can be explained`,
    )
  }
  const steps = Array.isArray(pipeline.steps) ? pipeline.steps : []
  return {
    id: pipeline.id,
    retry: resolveRetryPolicy(undefined, pipeline.retry, defaults.retry),
    onError: pipeline.onError ?? defaults.onError,
    ...(pipeline.envDefaults ? { envDefaults: maskEnvDefaults(pipeline.envDefaults) } : {}),
    stepCount: steps.length,
    steps: steps.map((step, index) =>
      explainStep(step, index + 1, pipeline, settings, defaults, warnings),
    ),
  }
}

function explainStep(
  step: PipelineStep,
  index: number,
  pipeline: Pipeline,
  settings: Settings,
  defaults: EffectiveDefaults,
  warnings: string[],
): ExplainedStep {
  const configuredName = stepConfigName(step)
  const stepIdName = configuredName ?? step.type
  const stepIdPattern = `${step.type}-${stepIdName}-<seq>`
  const base: ExplainedStep = {
    index,
    type: step.type,
    ...(configuredName !== undefined ? { name: configuredName } : {}),
    stepIdName,
    stepIdPattern,
    eventStepId: stepIdPattern,
    description: '',
    cardinality: '1 → 1',
  }

  switch (step.type) {
    case 'source': {
      const rawUri = String(step.config.uri ?? '')
      const expanded = expandUri(rawUri, settings, warnings)
      const source =
        (step.config.instance as Source<unknown> | undefined) ??
        resolveRegistered('source', expanded, stepIdPattern, warnings)
      return {
        ...base,
        uri: expanded.uri,
        alias: expanded.alias,
        aliasError: expanded.error,
        ...(source ? { sourceLifestyle: String(source.lifestyle) } : {}),
        ...(source ? { sourceResumable: typeof source.resume === 'function' } : {}),
        cardinality: '0 → N',
        description: `read from ${formatUri(expanded)}${
          source
            ? `; instance lifestyle ${source.lifestyle}${
                typeof source.resume === 'function' ? '; supports resume()' : '; replay-only'
              }`
            : '; resolved from the registry at run time'
        }`,
      }
    }
    case 'tool': {
      const tool = step.config.tool as Tool<unknown, unknown> | undefined
      if (!tool) {
        warnings.push(
          `Step ${index} (${stepIdPattern}): tool step has no tool instance; Runner passes the stream through unchanged and emits no step-done`,
        )
        return {
          ...base,
          eventStepId: undefined,
          cardinality: '1 → 1 (no-op)',
          description: 'invalid tool step: no tool instance',
        }
      }
      const name = tool.name
      const version = tool.version ? ` v${tool.version}` : ''
      const description = firstLine(tool?.mdDescription)
      const retry = resolveRetryPolicy(
        step.config.retry as PartialRetryPolicy | undefined,
        pipeline.retry,
        defaults.retry,
      )
      const onError =
        (step.config.onError as ErrorPolicy | undefined) ?? pipeline.onError ?? defaults.onError
      const concurrency = Number.parseInt(
        (step.config.concurrency as string | undefined) ?? defaults.concurrency.toString(),
        10,
      )
      return {
        ...base,
        name,
        description: `run ${name}${version}${description ? ` — ${description}` : ''}`,
        retry,
        onError,
        concurrency,
        cacheable: tool?.cacheable === true,
        idempotent: tool?.idempotent === true,
      }
    }
    case 'target': {
      const rawUri = String(step.config.uri ?? '')
      const expanded = expandUri(rawUri, settings, warnings)
      const target =
        (step.config.instance as Target<unknown> | undefined) ??
        resolveRegistered('target', expanded, stepIdPattern, warnings)
      return {
        ...base,
        uri: expanded.uri,
        alias: expanded.alias,
        aliasError: expanded.error,
        ...(target ? { targetDurableCheckpoint: typeof target.checkpoint === 'function' } : {}),
        cardinality: 'N → 0 (sink)',
        description: `write to ${formatUri(expanded)}${
          target
            ? typeof target.checkpoint === 'function'
              ? '; instance provides durable checkpoint() for crash-safe cursor clamping'
              : '; instance commits on close()'
            : '; resolved from the registry at run time; commits on close()'
        }`,
      }
    }
    case 'batch': {
      const size = effectiveBatchSize(step)
      const slide = step.config.slide === true
      const nested = step.config.pipeline as Pipeline | undefined
      if (nested && slide) {
        warnings.push(
          `Step ${index} (${stepIdPattern}): .batch(opts, nested) rejects slide=true at pipeline-definition time; if a hand-built step carries both, Runner still groups it as a sliding window`,
        )
      }
      return {
        ...base,
        checkpointNode: nested ? `${stepIdPattern}/batch-<n>` : undefined,
        cardinality: nested
          ? slide
            ? 'N → (N - size + 1) × size member emissions (N >= size; sliding windows repeat members; remainder dropped)'
            : 'N → N (members patched)'
          : slide
            ? 'N → N - size + 1 sliding windows (N >= size; remainder dropped)'
            : 'N → ceil(N / size) groups (remainder flushed)',
        description: nested
          ? `group every ${size}${slide ? ' (sliding windows)' : ''}; run nested pipeline '${nested.id}' per group and continue with the patched member stream`
          : `group every ${size}${slide ? ' (sliding windows)' : ' (tumbling; flushes the remainder)'}; emit one batched Exchange per group`,
        nested: nested ? [explainPipeline(nested, settings, defaults, warnings)] : undefined,
      }
    }
    case 'flatmap': {
      if (typeof step.config.fn !== 'function') {
        warnings.push(
          `Step ${index} (${stepIdPattern}): flatMap step has no callback; Runner throws when the stream is consumed`,
        )
        return {
          ...base,
          eventStepId: undefined,
          cardinality: '1 → N (invalid)',
          description: 'invalid flatMap step: callback is not a function',
        }
      }
      return {
        ...base,
        cardinality: '1 → N',
        description: `fan out 1 → N using callback ${callbackName(step.config.fn)}; children get '<parentId>.<n>' ids and meta.parentId`,
      }
    }
    case 'split': {
      const splitter = step.config.splitter as Splitter<unknown> | undefined
      const splitterType = String(step.config.splitterType ?? '')
      if (!splitter) {
        warnings.push(
          `Step ${index} (${stepIdPattern}): split step has no splitter instance; Runner throws when the stream is consumed`,
        )
      }
      const displayName = splitter?.name ?? (splitterType || '<missing>')
      return {
        ...base,
        ...(!splitter ? { eventStepId: undefined } : {}),
        name: splitter?.name,
        splitterType: splitterType || undefined,
        cardinality: '1 → N',
        description: `fan out 1 → N with splitter '${displayName}'${
          splitterType ? ` (${splitterType})` : ''
        }`,
      }
    }
    case 'tap': {
      if (typeof step.config.fn !== 'function') {
        warnings.push(
          `Step ${index} (${stepIdPattern}): tap step has no callback; Runner throws when the stream is consumed`,
        )
        return {
          ...base,
          eventStepId: undefined,
          description: 'invalid tap step: callback is not a function',
        }
      }
      return {
        ...base,
        description: `observe each Exchange with ${callbackName(step.config.fn)}; the stream passes through unchanged`,
      }
    }
    case 'fork': {
      const parallel = step.config.parallel === true && Array.isArray(step.config.pipelines)
      const branches = parallel ? (step.config.pipelines as Pipeline[]) : []
      const child = step.config.pipeline as Pipeline | undefined
      const nested = parallel ? branches : child ? [child] : []
      if (!parallel && !child) {
        warnings.push(
          `Step ${index} (${stepIdPattern}): fork step has neither a child pipeline nor a parallel branch array; Runner throws at run time`,
        )
      }
      return {
        ...base,
        ...(!parallel && !child ? { eventStepId: undefined } : {}),
        checkpointNode:
          parallel && branches.length > 0
            ? `${stepIdPattern}/fork-<parent>/branch-<branch>`
            : child
              ? `${stepIdPattern}/fork-<n>`
              : undefined,
        cardinality: parallel
          ? `1 → sum of ${branches.length} branch outputs (each branch may emit 0..M; declaration-order merge)`
          : '1 → child output',
        description: parallel
          ? `run ${branches.length} branches per envelope concurrently (isolated clone per branch; declaration-order merge; a failure fails the run after all settle)`
          : `run nested pipeline '${child?.id ?? '<unknown>'}' once per envelope, sequentially; outputs merge back in arrival order`,
        nested: nested.map((p) => explainPipeline(p, settings, defaults, warnings)),
      }
    }
    case 'subflow': {
      const child = step.config.pipeline as Pipeline | undefined
      const selfContained = child?.steps.some((s) => s.type === 'source') ?? false
      if (!child) {
        warnings.push(
          `Step ${index} (${stepIdPattern}): subflow step has no child pipeline; Runner throws at run time`,
        )
      }
      return {
        ...base,
        ...(!child ? { eventStepId: undefined } : {}),
        checkpointNode: child ? `${stepIdPattern}/subflow` : undefined,
        cardinality: selfContained ? 'N → N (nested side effects)' : 'depends on nested steps',
        description: child
          ? selfContained
            ? `run self-contained nested pipeline '${child.id}' after the upstream drains; its output is drained and discarded, so the parent stream continues unchanged`
            : `splice inline nested pipeline '${child.id}' into the current stream`
          : 'invalid subflow step',
        nested: child ? [explainPipeline(child, settings, defaults, warnings)] : undefined,
      }
    }
    default:
      return base
  }
}

/**
 * Runner.nextStepId uses `config.name ?? step.type`. An empty string is still a
 * declared name, so it must not be replaced by the fallback here either.
 */
function stepConfigName(step: PipelineStep): string | undefined {
  const name = step.config.name
  return name === undefined || name === null ? undefined : String(name)
}

/** Runner.groupStream falls back to size 1 for a non-positive/non-finite batch size. */
function effectiveBatchSize(step: PipelineStep): number {
  const size = Number(step.config.size)
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 1
}

/**
 * Warn once per id shared by two or more *distinct* Pipeline objects.
 *
 * Object identity matters: reusing one Pipeline instance in several places (a common
 * ladder pattern) is fine — the same object simply gets explained twice. Only separate
 * declarations that end up with the same id make `resume`/`inspect` ambiguous.
 */
function duplicatePipelineIdWarnings(runnable: Pipeline | PipelineSuite): string[] {
  const roots = isPipelineSuite(runnable) ? runnable.pipelines : [runnable]
  const byId = new Map<string, Pipeline[]>()
  const seen = new Set<Pipeline>()

  const visit = (pipeline: Pipeline): void => {
    if (seen.has(pipeline)) return
    seen.add(pipeline)
    const sameId = byId.get(pipeline.id) ?? []
    sameId.push(pipeline)
    byId.set(pipeline.id, sameId)
    for (const step of pipeline.steps ?? []) {
      const child = step.config.pipeline as Pipeline | undefined
      if (child) visit(child)
      const branches = step.config.pipelines as Pipeline[] | undefined
      if (Array.isArray(branches)) for (const branch of branches) visit(branch)
    }
  }
  for (const pipeline of roots) visit(pipeline)

  return [...byId.entries()]
    .filter(([, pipelines]) => pipelines.length > 1)
    .map(
      ([id, pipelines]) =>
        `${pipelines.length} distinct pipelines share id '${id}' (often because bare definePipeline() defaults to the file name); mt resume/inspect identify a run by pipeline id — give them explicit unique ids`,
    )
}

function expandUri(
  raw: string,
  settings: Settings,
  warnings: string[],
): { uri: string; alias?: string; error?: string } {
  try {
    const uri = registry.expandAliases(raw, settings)
    return uri === raw ? { uri } : { uri, alias: raw }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(message)
    return { uri: raw, alias: raw.startsWith('@') ? raw : undefined, error: message }
  }
}

/**
 * Resolve a URI string through the registry (no I/O at construction) so the explanation can
 * report `lifestyle`/`resume()`/`checkpoint()` instead of only saying "resolved at run time".
 * Resolution failures become warnings: the same URI would fail `mt run` too.
 */
function resolveRegistered<T extends Source<unknown> | Target<unknown>>(
  kind: 'source' | 'target',
  expanded: { uri: string; alias?: string; error?: string },
  stepId: string,
  warnings: string[],
): T | undefined {
  if (!expanded.uri || expanded.error) return undefined
  try {
    return (
      kind === 'source'
        ? registry.resolveSource(expanded.uri)
        : registry.resolveTarget(expanded.uri)
    ) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(
      `Step ${stepId}: ${kind} URI ${formatUri(expanded)} cannot be resolved now — ${message}`,
    )
    return undefined
  }
}

function formatUri(expanded: { uri: string; alias?: string; error?: string }): string {
  if (expanded.error) return `\`${expanded.uri}\` (alias unresolved: ${expanded.error})`
  if (expanded.alias) return `\`${expanded.uri}\` (${expanded.alias})`
  return `\`${expanded.uri}\``
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

function callbackName(value: unknown): string {
  if (typeof value === 'function' && value.name) return `\`${value.name}\``
  return '<anonymous>'
}

function formatRetry(retry: RetryPolicy): string {
  const cap = retry.maxBackoffMs !== undefined ? `, maxBackoffMs=${retry.maxBackoffMs}` : ''
  return `${retry.strategy}(max=${retry.max}, backoffMs=${retry.backoffMs}${cap})`
}

const CREDENTIAL_PATTERN = /(?:key|token|secret|password|passwd|credential|auth)/i

/**
 * Copy env defaults with credential-looking values masked, in Markdown and JSON alike.
 * A key or value that looks like a credential keeps its name and loses its value.
 */
function maskEnvDefaults(envDefaults: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(envDefaults)) {
    masked[key] = CREDENTIAL_PATTERN.test(key) || CREDENTIAL_PATTERN.test(value) ? '***' : value
  }
  return masked
}

/** Render non-secret env defaults; a value that looks like a credential is replaced by its key. */
function formatEnvDefaults(envDefaults: Record<string, string>): string {
  return Object.entries(envDefaults)
    .map(([key, value]) => {
      if (value === '***' || CREDENTIAL_PATTERN.test(key) || CREDENTIAL_PATTERN.test(value)) {
        return `\`${mdCell(key)}\``
      }
      return `\`${mdCell(`${key}=${value}`)}\``
    })
    .join(', ')
}

function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** Render a {@link PipelineExplanation} as Markdown for humans and coding agents. */
export function renderExplanation(explanation: PipelineExplanation): string {
  const lines: string[] = []
  lines.push(`# mt explain — ${explanation.file}`)
  lines.push('')
  lines.push(
    '> **Explain only.** The pipeline module is imported (top-level code runs), but no Runner,',
  )
  lines.push(
    '> source, tool, target or lifecycle hook is started. No run id, state, log, artifact or',
  )
  lines.push('> cache entry is created.')
  lines.push('')
  lines.push(`- Project: \`${explanation.project.name}\` (\`${explanation.project.root}\`)`)
  lines.push(`- Runnable: ${runnableLabel(explanation.runnable)}`)
  if (explanation.llm) {
    const declared = [
      explanation.llm.tool !== undefined ? `tool \`${explanation.llm.tool}\`` : undefined,
      explanation.llm.model !== undefined ? `model \`${explanation.llm.model}\`` : undefined,
    ].filter((value): value is string => value !== undefined)
    lines.push(
      `- LLM (mt.json): ${declared.length > 0 ? declared.join('; ') : 'tool and model not declared'}. ${explanation.llm.note}`,
    )
  }
  lines.push(
    `- Project fallback defaults: retry \`${formatRetry(explanation.defaults.retry)}\`; onError \`${explanation.defaults.onError}\`; concurrency \`${explanation.defaults.concurrency}\``,
  )
  lines.push(`  ${explanation.defaultsNote}`)
  lines.push('')
  renderHooks(lines, explanation.runtime)
  renderRuntime(lines, explanation.runtime)
  renderWarnings(lines, explanation.warnings)

  if (explanation.runnable.kind === 'suite') {
    const suite = explanation.runnable
    lines.push('## Suite execution')
    lines.push('')
    lines.push(
      `Suite \`${suite.id}\` has ${suite.pipelineCount} pipeline(s) in \`${suite.mode ?? 'sync'}\` mode.`,
    )
    lines.push(
      suite.mode === 'parallel'
        ? 'Each pipeline gets its own Runner/run id and they run concurrently.'
        : 'Each pipeline gets its own Runner/run id and they run one after another; the first failure stops the suite.',
    )
    lines.push('')
    for (const [index, pipeline] of suite.pipelines.entries()) {
      lines.push(`${index + 1}. \`${pipeline.id}\` (${pipeline.stepCount} steps)`)
    }
    lines.push('')
  }

  for (const [index, pipeline] of explanation.runnable.pipelines.entries()) {
    const label =
      explanation.runnable.kind === 'suite'
        ? `Pipeline ${index + 1} of ${explanation.runnable.pipelineCount}`
        : 'Pipeline'
    renderPipeline(lines, pipeline, 2, label, true)
  }

  return lines.join('\n')
}

function runnableLabel(runnable: ExplainedRunnable): string {
  if (runnable.kind === 'suite') {
    return `suite \`${runnable.id}\` (${runnable.pipelineCount} pipelines, mode \`${runnable.mode ?? 'sync'}\`)`
  }
  return `pipeline \`${runnable.id}\``
}

function renderHooks(lines: string[], runtime: ExplainedRuntime): void {
  lines.push('## Lifecycle hooks (executed by `mt run`, never by `mt explain`)')
  lines.push('')
  const declared = Object.entries(runtime.hooks).filter(([, value]) => value !== undefined)
  if (declared.length === 0) {
    lines.push('No lifecycle hooks are declared in `mt.json`.')
  } else {
    lines.push('| Hook | Pipeline file | When |')
    lines.push('|---|---|---|')
    const when: Record<string, string> = {
      start: 'before the main pipeline; a failure fails the run',
      end: 'after the run, on success or failure',
      error: 'after the main pipeline fails',
      stop: 'on Ctrl-C / pause',
      exit: 'last, before the process exits',
    }
    for (const [name, file] of declared) {
      lines.push(`| \`${name}\` | \`${file}\` | ${when[name] ?? ''} |`)
    }
  }
  lines.push('')
}

function renderRuntime(lines: string[], runtime: ExplainedRuntime): void {
  lines.push('## Run lifecycle, events and logs (created by `mt run`)')
  lines.push('')
  lines.push(
    'State machine: `pending` → `running` → {`done` | `failed`}; pause: `running` → `paused` → `resumed` → `running`; `mt resume` re-runs a failed/paused run.',
  )
  lines.push(`  ${runtime.stateMachineNote}`)
  lines.push('')
  lines.push('Event ordering:')
  lines.push('')
  for (const order of runtime.eventOrder) lines.push(`- ${order}`)
  lines.push('')
  lines.push(`Event types: ${runtime.eventTypes.map((s) => `\`${s}\``).join(', ')}.`)
  lines.push('')
  lines.push(`Run directory: \`${runtime.runDir}\`; cache directory: \`${runtime.cacheDir}\``)
  lines.push('')
  lines.push('| Path | Contents |')
  lines.push('|---|---|')
  for (const [file, description] of Object.entries(runtime.files)) {
    lines.push(`| \`${file}\` | ${mdCell(description)} |`)
  }
  lines.push('')
  lines.push(
    'Step ids use `<type>-<config.name ?? type>-<seq>`; `<seq>` is a global counter assigned by the',
  )
  lines.push('Runner in execution order. Source/target steps usually have no `config.name`, hence')
  lines.push(
    '`source-source-<seq>` / `target-target-<seq>`. A `step-done` is emitted only when the Runner',
  )
  lines.push(
    "reaches and exhausts that step's stream (or finishes the target write). A downstream throw or",
  )
  lines.push(
    'early consumer exit stops before the boundary, so upstream steps can lack the event; a tool step',
  )
  lines.push(
    'with no instance returns its upstream stream unchanged and never emits one. For fork, batch and',
  )
  lines.push(
    'subflow, the checkpoint-node id is also the id of the nested-completion `step-done` event.',
  )
  lines.push(
    '`logs/<stepId>.log` is created lazily on the first log line for that id, with every character',
  )
  lines.push(
    'outside `[A-Za-z0-9._-]` replaced by `_` (for example `fork-views-2/fork-0/branch-1` ->',
  )
  lines.push(
    '`fork-views-2_fork-0_branch-1.log`). Reached steps get at least the engine config line; steps',
  )
  lines.push(
    'never reached, and nested checkpoint nodes that log nothing, get no log file. The checkpoint',
  )
  lines.push(
    'tree is `root` plus flat child nodes; node ids encode the fork/subflow/batch path (`<n>`,',
  )
  lines.push('`<parent>` and `<branch>` are zero-based).')
  lines.push(
    'Resume uses `state.json` (checkpoint tree + source cursor); it keeps the run id and emits no new `started`.',
  )
  lines.push('')
}

function renderWarnings(lines: string[], warnings: string[]): void {
  if (warnings.length === 0) return
  lines.push('## Warnings')
  lines.push('')
  for (const warning of warnings) lines.push(`- ${warning}`)
  lines.push('')
}

function renderPipeline(
  lines: string[],
  pipeline: ExplainedPipeline,
  level: number,
  label: string,
  envDefaultsApplied: boolean,
): void {
  const heading = '#'.repeat(Math.min(level, 6))
  lines.push(`${heading} ${label}: \`${pipeline.id}\``)
  lines.push('')
  lines.push(
    `Retry: \`${formatRetry(pipeline.retry)}\`; onError: \`${pipeline.onError}\`; steps: ${pipeline.stepCount}.`,
  )
  lines.push('')
  lines.push(
    'The pipeline-level policy is the inherited baseline; tool steps show their effective policy after step/pipeline/project merge.',
  )
  lines.push('')
  if (pipeline.envDefaults && Object.keys(pipeline.envDefaults).length > 0) {
    lines.push(`Env defaults: ${formatEnvDefaults(pipeline.envDefaults)}.`)
    lines.push(
      envDefaultsApplied
        ? 'Applied by Runner to the run env only when the key is not already set in process.env or the mt.json env.'
        : "Not applied by Runner: envDefaults are read only from the runnable's top-level pipeline.",
    )
    lines.push('')
  }
  lines.push(`${'#'.repeat(Math.min(level + 1, 6))} Dataflow`)
  lines.push('')
  lines.push('```text')
  if (pipeline.steps.length === 0) lines.push('(no steps declared)')
  else lines.push(...dataflowLines(pipeline))
  lines.push('```')
  lines.push('')
  lines.push(`${'#'.repeat(Math.min(level + 1, 6))} Steps`)
  lines.push('')
  lines.push('| # | Kind | What it does | Cardinality | Step id / event id |')
  lines.push('|---|---|---|---|---|')
  for (const step of pipeline.steps) {
    const policy = step.retry
      ? `retry \`${formatRetry(step.retry)}\`; onError \`${step.onError}\`${
          step.cacheable ? '; cacheable' : ''
        }${step.idempotent ? '; idempotent' : ''}`
      : ''
    const concurrency =
      step.concurrency !== undefined ? `concurrency \`${step.concurrency}\`` : undefined
    const detail = [step.description, policy, concurrency].filter(Boolean).join('; ')
    const ids = [
      `step: \`${step.stepIdPattern}\``,
      step.eventStepId ? `event: \`${step.eventStepId}\`` : undefined,
      step.checkpointNode ? `node/event: \`${step.checkpointNode}\`` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join('<br>')
    lines.push(
      `| ${step.index} | \`${step.type}\` | ${mdCell(detail)} | ${mdCell(step.cardinality)} | ${ids} |`,
    )
  }
  lines.push('')
  if (pipeline.steps.some((step) => step.concurrency !== undefined)) {
    lines.push(
      'Tool items run through ordered `mapConcurrent`, so output order is preserved even when `concurrency` > 1.',
    )
    lines.push('')
  }

  for (const step of pipeline.steps) {
    if (!step.nested || step.nested.length === 0) continue
    let relation = 'nested pipeline'
    if (step.type === 'fork' && step.nested.length > 1) relation = 'branch'
    else if (step.type === 'batch') relation = 'batch scope'
    for (const [index, nested] of step.nested.entries()) {
      const suffix =
        step.nested.length > 1 ? ` (${relation} ${index + 1} of ${step.nested.length})` : ''
      renderPipeline(
        lines,
        nested,
        level + 1,
        `Nested pipeline from step ${step.index}${suffix}`,
        false,
      )
    }
  }
}

function dataflowLines(pipeline: ExplainedPipeline): string[] {
  const lines: string[] = []
  for (const step of pipeline.steps) {
    const prefix = step.index === 1 ? '' : '  → '
    const indent = step.index === 1 ? '' : '  '
    lines.push(`${prefix}${dataflowDetail(step)}`)
    if (!step.nested || step.nested.length === 0) continue
    for (const [index, nested] of step.nested.entries()) {
      const branchLabel = step.nested.length > 1 ? `branch ${index + 1}: ` : ''
      lines.push(`${indent}    ↳ ${branchLabel}${nested.id}`)
      for (const nestedLine of dataflowLines(nested)) {
        lines.push(`${indent}      ${nestedLine}`)
      }
    }
  }
  return lines
}

function dataflowDetail(step: ExplainedStep): string {
  switch (step.type) {
    case 'source':
      return `source ${step.uri ?? ''}`
    case 'target':
      return `target ${step.uri ?? ''}`
    case 'tool':
      return `tool ${step.name ?? '<unnamed>'}`
    case 'flatmap':
      return 'flatMap (1 → N)'
    case 'split':
      return `split ${step.name ?? ''} (1 → N)`
    case 'tap':
      return 'tap (observe)'
    case 'batch':
      return step.nested ? `batch (scope ${step.nested[0]?.id ?? ''})` : 'batch'
    case 'fork':
      return `fork ${step.nested?.length ?? 0} pipeline(s)`
    case 'subflow':
      return `subflow ${step.nested?.[0]?.id ?? ''}`
    default:
      return step.type
  }
}
