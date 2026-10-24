import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ErrorPolicy, GlobalContext, RetryPolicy, RunContext, StepInfo } from '../contexts.js'
import { Store } from '../store.js'
import type { Envelope, Logger, Pipeline, PipelineStep, RunStateData, Tool } from '../types.js'
import { registry } from '../uri.js'
import { Cache } from './cache.js'
import {
  addChild,
  createRootCheckpoint,
  findFirstNonDone,
  findNode,
  markDone,
  markFailed,
  markInProgress,
  serializeTree,
} from './checkpoint.js'
import { writeDeadLetter } from './dead-letter.js'
import { autoCommit } from './git.js'
import { withRetry } from './retry.js'
import { RunStateMachine } from './state-machine.js'
import { mapConcurrent } from './stream.js'

/**
 * A stream of envelopes flowing through pipeline steps.
 */
type EnvelopeStream = AsyncIterable<Envelope<unknown>>

/**
 * Stream of a single envelope — the input handed to a forked child pipeline.
 */
async function* singleEnvelope(env: Envelope<unknown>): EnvelopeStream {
  yield env
}

/**
 * Stream of one empty envelope — lets tool-only pipelines run without a source.
 */
async function* emptyEnvelope(): EnvelopeStream {
  yield { item: {}, meta: {} }
}

/**
 * Drain a stream without emitting its envelopes (targets already consumed it).
 */
async function drainStream(stream: EnvelopeStream): Promise<void> {
  for await (const _ of stream) {
    // no-op
  }
}

/**
 * Fold a group of envelopes into a single batched envelope.
 * `item` holds the array too, so plain (non-batch-aware) tools and `flatMap` see the group.
 */
function toBatchEnvelope(group: Envelope<unknown>[]): Envelope<unknown> {
  const items = group.map((env) => env.item)
  return { item: items, items, meta: group[0]?.meta ?? {} }
}

/**
 * Group envelopes by cardinality: `batch` tumbles (flushes the remainder at end of
 * stream), `window` slides one item at a time so consecutive groups overlap.
 */
function groupStream(
  source: EnvelopeStream,
  size: number,
  mode: 'batch' | 'window',
): EnvelopeStream {
  const groupSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1

  return (async function* () {
    let group: Envelope<unknown>[] = []

    for await (const env of source) {
      group.push(env)
      if (group.length < groupSize) continue

      yield toBatchEnvelope(group)
      group = mode === 'batch' ? [] : group.slice(1)
    }

    if (mode === 'batch' && group.length > 0) {
      yield toBatchEnvelope(group)
    }
  })()
}

/**
 * Runner — executes a pipeline definition, manages state machine, checkpointing, and logging.
 */
export class Runner {
  private readonly pipeline: Pipeline
  private readonly globalContext: GlobalContext
  private readonly store: Store
  private readonly stateMachine: RunStateMachine
  private readonly cache: Cache
  private runId: string | null = null
  private runContext: RunContext | null = null
  private checkpoint = createRootCheckpoint('root')
  private stepSeq = 0

  constructor(pipeline: Pipeline, globalContext: GlobalContext) {
    this.pipeline = pipeline
    this.globalContext = globalContext
    const mtRoot = join(globalContext.project.root, '.mt')
    this.store = new Store(mtRoot)
    this.cache = new Cache(mtRoot)
    this.stateMachine = new RunStateMachine()
  }

  /**
   * Start executing the pipeline.
   */
  async start(): Promise<RunContext> {
    this.runId = randomUUID()
    this.stateMachine.transition('running')

    const runContext = this.createRunContext()
    this.runContext = runContext

    // Persist initial state
    await this.persistState()

    // Walk pipeline steps
    try {
      await this.executeSteps()
    } catch (error) {
      await this.failRun(error)
      throw error
    }

    // Mark done
    this.stateMachine.transition('done')
    await this.persistState()

    return runContext
  }

  /**
   * Pause the runner.
   */
  async pause(): Promise<void> {
    if (this.stateMachine.canTransition('paused')) {
      this.stateMachine.transition('paused')
      await this.persistState()
    }
  }

  /**
   * Unpause a paused runner (in-memory, without reloading state).
   * Transitions paused → resumed → running so the executeSteps loop continues.
   */
  async unpause(): Promise<void> {
    if (this.stateMachine.current !== 'paused') return
    if (this.stateMachine.canTransition('resumed')) {
      this.stateMachine.transition('resumed')
    }
    if (this.stateMachine.canTransition('running')) {
      this.stateMachine.transition('running')
    }
    await this.persistState()
  }

  /**
   * Resume execution from a saved state.
   */
  async resume(runId: string): Promise<RunContext> {
    // Load state
    const stateData = await this.store.readJson<RunStateData>('runs', runId, 'state.json')
    this.runId = runId
    this.stateMachine.reset(stateData.state)
    this.checkpoint = stateData.checkpoint

    const runContext = this.createRunContext()
    this.runContext = runContext

    // Transition to resumed
    if (this.stateMachine.canTransition('resumed')) {
      this.stateMachine.transition('resumed')
    }
    if (this.stateMachine.canTransition('running')) {
      this.stateMachine.transition('running')
    }

    // Find first non-done node and continue
    const resumeNode = findFirstNonDone(this.checkpoint)
    if (resumeNode) {
      try {
        await this.executeSteps()
      } catch (error) {
        await this.failRun(error)
        throw error
      }
    }

    this.stateMachine.transition('done')
    await this.persistState()

    return runContext
  }

  /**
   * Execute pipeline steps by streaming envelopes through them.
   * Entry point of the run: builds the top-level stream and drains it.
   */
  private async executeSteps(): Promise<void> {
    const runContext = this.runContext
    if (!runContext) throw new Error('Run not started')

    const stream = await this.buildStream(this.pipeline, null, runContext)

    // Drain stream if we ended without a target
    if (stream) {
      await drainStream(stream)
    }
  }

  /**
   * Build the envelope stream for a pipeline's steps.
   *
   * Recursive: `fork` and `subflow` call this again with the child pipeline, so nested
   * pipelines support every DSL op (source/target/batch/window/flatMap/tap/fork/subflow)
   * instead of a tool-only subset. The incoming `input` stream is the head of the chain;
   * `null` means the pipeline must supply its own data via a `source` step.
   */
  private async buildStream(
    pipeline: Pipeline,
    input: EnvelopeStream | null,
    runContext: RunContext,
  ): Promise<EnvelopeStream | null> {
    let stream = input
    let hasSourceStep = false

    for (const step of pipeline.steps) {
      // Pause if signaled
      while (this.stateMachine.current === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (this.stateMachine.current !== 'running') break

      const stepId = this.nextStepId(step)

      this.logger(stepId).info(`Configuring pipeline stream for step: ${step.type} (${stepId})`)

      switch (step.type) {
        case 'source': {
          hasSourceStep = true
          const rawUri = step.config.uri as string
          const uri = registry.expandAliases(rawUri, this.globalContext.settings)
          if (uri !== rawUri) this.logger(stepId).info(`Resolved URI alias '${rawUri}' → '${uri}'`)
          const source = registry.resolveSource(uri)
          stream = source.start({ run: runContext })
          break
        }
        case 'tool': {
          if (!stream && !hasSourceStep) {
            stream = emptyEnvelope()
          }
          if (!stream) {
            throw new Error('Tool step requires a preceding stream or source step')
          }
          stream = this.runTool(step, stream, stepId, pipeline, runContext)
          break
        }
        case 'target': {
          await this.writeTarget(step, stepId, stream, runContext)
          break
        }
        case 'batch':
        case 'window': {
          const size = Number(step.config.size)
          if (!stream && !hasSourceStep) {
            stream = emptyEnvelope()
          }
          if (!stream) {
            throw new Error('Batch/window step requires a preceding stream or source step')
          }
          stream = groupStream(stream, size, step.type)
          break
        }
        case 'flatmap': {
          const fn = step.config.fn as (item: unknown) => Promise<unknown[]>
          if (!stream && !hasSourceStep) {
            stream = emptyEnvelope()
          }
          if (!stream) {
            throw new Error('FlatMap step requires a preceding stream or source step')
          }
          const sourceStream = stream
          stream = (async function* () {
            for await (const env of sourceStream) {
              const items = await fn(env.item)
              for (const item of items) {
                yield { item, meta: env.meta }
              }
            }
          })()
          break
        }
        case 'tap': {
          const fn = step.config.fn as (item: unknown) => Promise<void>
          if (!stream && !hasSourceStep) {
            stream = emptyEnvelope()
          }
          if (!stream) {
            throw new Error('Tap step requires a preceding stream or source step')
          }
          const sourceStream = stream
          stream = (async function* () {
            for await (const env of sourceStream) {
              await fn(env.item)
              yield env
            }
          })()
          break
        }
        case 'fork': {
          if (!stream && !hasSourceStep) {
            stream = emptyEnvelope()
          }
          if (!stream) {
            throw new Error('Fork step requires a preceding stream or source step')
          }
          stream = this.forkStream(step, stream, stepId, runContext)
          break
        }
        case 'subflow': {
          stream = await this.subflowStream(step, stream, stepId, runContext)
          break
        }
        default:
          this.logger(stepId).warn(`Unsupported pipeline step type in stream: ${step.type}`)
      }
    }

    return stream
  }

  /**
   * Fork — run the child pipeline per parent envelope and merge results back
   * into the parent stream. Each envelope gets its own checkpoint node.
   */
  private forkStream(
    step: PipelineStep,
    sourceStream: EnvelopeStream | null,
    stepId: string,
    runContext: RunContext,
  ): EnvelopeStream {
    const subPipeline = step.config.pipeline as Pipeline
    const runner = this
    let forkIndex = 0

    return (async function* () {
      if (!sourceStream) return
      for await (const env of sourceStream) {
        const nodeId = `${stepId}/fork-${forkIndex++}`
        const childContext = runner.enterNested(runContext, nodeId, subPipeline.id)

        try {
          const childStream = await runner.buildStream(
            subPipeline,
            singleEnvelope(env),
            childContext,
          )
          if (childStream) {
            for await (const out of childStream) {
              yield out
            }
          }
          runner.completeNested(nodeId)
        } catch (error) {
          runner.failNested(nodeId, error as Error)
          throw error
        }
      }
    })()
  }

  /**
   * Subflow — run a child pipeline inside the parent's stream.
   *
   * A sub-pipeline that declares its own `source` is self-contained: it runs as a nested
   * orchestration step and leaves the parent stream untouched. A steps-only sub-pipeline
   * is an inline transform: its steps are spliced into the parent stream.
   */
  private async subflowStream(
    step: PipelineStep,
    upstream: EnvelopeStream | null,
    stepId: string,
    runContext: RunContext,
  ): Promise<EnvelopeStream | null> {
    const subPipeline = step.config.pipeline as Pipeline
    const nodeId = `${stepId}/subflow`
    const selfContained = subPipeline.steps.some((s) => s.type === 'source')

    if (!selfContained) {
      const childContext = this.enterNested(runContext, nodeId, subPipeline.id)
      const childStream = await this.buildStream(subPipeline, upstream, childContext)
      return this.trackNested(nodeId, childStream)
    }

    this.logger(stepId).info(
      `Running self-contained sub-pipeline: ${subPipeline.id} (parent stream unchanged)`,
    )

    const runner = this
    return (async function* () {
      // Upstream first: the nested run happens once the preceding stream is consumed,
      // so side effects land in declaration order — not while the stream is being built.
      if (upstream) {
        for await (const env of upstream) {
          yield env
        }
      }

      const childContext = runner.enterNested(runContext, nodeId, subPipeline.id)
      try {
        const childStream = await runner.buildStream(subPipeline, null, childContext)
        if (childStream) {
          await drainStream(childStream)
        }
        runner.completeNested(nodeId)
      } catch (error) {
        runner.failNested(nodeId, error as Error)
        throw error
      }
    })()
  }

  /**
   * Execute a single tool envelope: cache lookup → retry → invoke → cache store → error policy.
   */
  private async runToolItem<I, O>(
    tool: Tool<I, O>,
    env: Envelope<I>,
    stepId: string,
    runContext: RunContext,
    toolContext: Record<string, unknown> | undefined,
    retryPolicy: RetryPolicy,
    onError: ErrorPolicy,
  ): Promise<Envelope<O> | undefined> {
    const stepInfo: StepInfo = { stepId, name: tool.name, type: 'tool', index: 0 }
    const cache = this.cache
    const logger = this.logger(stepId)
    const store = this.store

    const cacheKey = tool.cacheable
      ? cache.computeKey({
          toolName: tool.name,
          version: tool.version,
          input: env,
          context: toolContext,
        })
      : null

    if (cacheKey && (await cache.has(cacheKey))) {
      const cached = await cache.get<Envelope<O>>(cacheKey)
      if (cached !== undefined) {
        logger.info(`Cache hit for tool ${tool.name}`)
        return cached
      }
    }

    try {
      const output = await withRetry(
        async () => tool.invoke(env, { run: runContext, step: stepInfo }),
        retryPolicy,
        (err, attempt) => {
          logger.warn(`Tool ${tool.name} failed (attempt ${attempt + 1}): ${err}`)
        },
      )

      if (cacheKey && output !== undefined) {
        await cache.set(
          cacheKey,
          {
            toolName: tool.name,
            version: tool.version,
            input: env,
            context: toolContext,
          },
          output,
        )
      }
      return output
    } catch (error) {
      logger.error(`Tool ${tool.name} failed after retries: ${error}`)
      if (onError === 'fail-run') {
        throw error
      }
      if (onError === 'dead-letter') {
        await writeDeadLetter(store, runContext.runId, env, error as Error, stepId)
        logger.warn(`Tool ${tool.name} failed, written to dead-letter queue: ${error}`)
      }
      if (onError === 'skip-item') {
        logger.warn(`Tool ${tool.name} failed, skipping item: ${error}`)
      }
      return undefined
    }
  }

  /**
   * Run a tool step over a stream: concurrency-limited, retried, cached, error-policy aware.
   */
  private runTool(
    step: PipelineStep,
    sourceStream: EnvelopeStream,
    stepId: string,
    pipeline: Pipeline,
    runContext: RunContext,
  ): EnvelopeStream {
    const tool = step.config.tool as Tool<unknown, unknown> | undefined
    if (!tool) return sourceStream

    const concurrency = Number.parseInt(
      (step.config.concurrency as string) ?? this.globalContext.defaults.concurrency.toString(),
      10,
    )
    const retryPolicy =
      (step.config.retry as RetryPolicy | undefined) ??
      pipeline.retry ??
      this.globalContext.defaults.retry
    const onError =
      (step.config.onError as ErrorPolicy | undefined) ??
      pipeline.onError ??
      this.globalContext.defaults.onError
    const toolContext = step.config.context as Record<string, unknown> | undefined

    return mapConcurrent(
      sourceStream,
      concurrency,
      async (env) =>
        this.runToolItem(tool, env, stepId, runContext, toolContext, retryPolicy, onError),
      { ordered: true },
    )
  }

  /**
   * Write a stream into a target, then close it (with optional auto-commit).
   * A target is a sink — the stream it consumed stays exhausted for downstream steps.
   */
  private async writeTarget(
    step: PipelineStep,
    stepId: string,
    stream: EnvelopeStream | null,
    runContext: RunContext,
  ): Promise<void> {
    const rawUri = step.config.uri as string
    const uri = registry.expandAliases(rawUri, this.globalContext.settings)
    if (uri !== rawUri) this.logger(stepId).info(`Resolved URI alias '${rawUri}' → '${uri}'`)
    const target = registry.resolveTarget(uri)
    if (!stream) throw new Error('Target step requires a preceding stream or source step')

    await target.open({ run: runContext })
    try {
      for await (const env of stream) {
        await target.write(env, { run: runContext })
      }
    } finally {
      await target.close({ run: runContext })
    }

    // Check for auto-commit on close
    const parsed = registry.parse(uri)
    if (parsed.query.commit === 'on-close') {
      this.logger('commit').info(`Auto-committing changes in: ${runContext.global.project.root}`)
      await autoCommit(runContext.global.project.root)
    }
  }

  /**
   * Register a nested checkpoint node and derive its run context (extended path, own logger).
   */
  private enterNested(runContext: RunContext, nodeId: string, pipelineId: string): RunContext {
    const node = createRootCheckpoint(nodeId)
    addChild(this.checkpoint, node)
    markInProgress(node)

    return {
      ...runContext,
      pipelineId,
      checkpoint: {
        stepId: nodeId,
        depth: runContext.checkpoint.depth + 1,
        path: [...runContext.checkpoint.path, nodeId],
      },
      logger: this.logger(nodeId),
    }
  }

  /**
   * Mark a nested node done once its stream is exhausted.
   */
  private completeNested(nodeId: string): void {
    const node = findNode(this.checkpoint, nodeId)
    if (node) markDone(node)
  }

  /**
   * Mark a nested node failed when its stream throws.
   */
  private failNested(nodeId: string, error: Error): void {
    const node = findNode(this.checkpoint, nodeId)
    if (node) markFailed(node, error.message)
  }

  /**
   * Pass a nested stream through, marking its checkpoint node done/failed as it completes.
   */
  private async *trackNested(
    nodeId: string,
    stream: EnvelopeStream | null,
  ): AsyncGenerator<Envelope<unknown>> {
    if (!stream) {
      this.completeNested(nodeId)
      return
    }
    try {
      for await (const env of stream) {
        yield env
      }
      this.completeNested(nodeId)
    } catch (error) {
      this.failNested(nodeId, error as Error)
      throw error
    }
  }

  /**
   * Generate a unique, filesystem-safe step id for logging and checkpointing.
   */
  private nextStepId(step: PipelineStep): string {
    const name = (step.config.name as string | undefined) ?? step.type
    return `${step.type}-${name}-${++this.stepSeq}`
  }

  /**
   * Record a run-level failure: mark the root checkpoint and transition to `failed`,
   * so a run that throws never lands as `done` (or a stale `running`).
   */
  private async failRun(error: unknown): Promise<void> {
    markFailed(this.checkpoint, error instanceof Error ? error.message : String(error))
    if (this.stateMachine.canTransition('failed')) {
      this.stateMachine.transition('failed')
    }
    try {
      await this.persistState()
    } catch (persistError) {
      // A storage failure must not mask the error that actually failed the run.
      console.error(`Failed to persist failed run state: ${persistError}`)
    }
  }

  /**
   * Persist the current run state to disk.
   */
  private async persistState(): Promise<void> {
    if (!this.runId) return

    const stateData: RunStateData = {
      runId: this.runId,
      pipelineId: this.pipeline.id,
      state: this.stateMachine.current,
      startedAt: this.runContext?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoint: serializeTree(this.checkpoint),
      contextRef: `runs/${this.runId}/context.json`,
    }

    await this.store.ensureDir('runs', this.runId)
    await this.store.ensureDir('runs', this.runId, 'artifacts')
    await this.store.writeJson(stateData, 'runs', this.runId, 'state.json')
    await this.store.writeJson(this.runContext ?? {}, 'runs', this.runId, 'context.json')
  }

  /**
   * Create a run context for this execution.
   */
  private createRunContext(): RunContext {
    const runId = this.runId ?? randomUUID()
    return {
      runId,
      pipelineId: this.pipeline.id,
      startedAt: new Date().toISOString(),
      global: this.globalContext,
      checkpoint: {
        stepId: this.checkpoint.stepId,
        depth: 0,
        path: [this.checkpoint.stepId],
      },
      logger: this.logger(),
      artifactsDir: join(this.globalContext.project.root, '.mt', 'runs', runId, 'artifacts'),
    }
  }

  /**
   * Write a log entry to the per-step log file.
   */
  private async logStep(
    stepId: string,
    level: string,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.runId) return
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level.toUpperCase()}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`
    // Nested checkpoint ids carry path separators — keep log file names flat.
    const file = `${stepId.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`
    await this.store.ensureDir('runs', this.runId, 'logs')
    await this.store.append(line, 'runs', this.runId, 'logs', file)
  }

  /**
   * Get or create the logger.
   */
  private logger(stepId?: string): Logger {
    // Default console logger
    return {
      info: (message: string, meta?: Record<string, unknown>) => {
        console.log(`[${new Date().toISOString()}] [INFO] ${message}`, meta ?? '')
        if (stepId) void this.logStep(stepId, 'info', message, meta)
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        console.warn(`[${new Date().toISOString()}] [WARN] ${message}`, meta ?? '')
        if (stepId) void this.logStep(stepId, 'warn', message, meta)
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, meta ?? '')
        if (stepId) void this.logStep(stepId, 'error', message, meta)
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        if (process.env.MT_DEBUG) {
          console.debug(`[${new Date().toISOString()}] [DEBUG] ${message}`, meta ?? '')
        }
        if (stepId) void this.logStep(stepId, 'debug', message, meta)
      },
    }
  }

  /**
   * Get the current run ID.
   */
  getRunId(): string | null {
    return this.runId
  }
}
