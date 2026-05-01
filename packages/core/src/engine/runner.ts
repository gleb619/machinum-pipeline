import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import pLimit from 'p-limit'
import type { ErrorPolicy, GlobalContext, RetryPolicy, RunContext } from '../contexts.js'
import { Store } from '../store.js'
import type { Logger, Pipeline, PipelineStep, RunStateData } from '../types.js'
import { registry } from '../uri.js'
// Side-effect import: triggers builtin source/target registration
import '../builtins/jsonl-source.js'
import { Cache } from './cache.js'
import {
  createRootCheckpoint,
  findFirstNonDone,
  findNode,
  markDone,
  markFailed,
  markInProgress,
  serializeTree,
} from './checkpoint.js'
import { runChildProcess } from './child-process.js'
import { writeDeadLetter } from './dead-letter.js'
import { autoCommit } from './git.js'
import { withRetry } from './retry.js'
import { RunStateMachine } from './state-machine.js'

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
    await this.executeSteps()

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
      await this.executeSteps()
    }

    this.stateMachine.transition('done')
    await this.persistState()

    return runContext
  }

  /**
   * Execute pipeline steps by streaming envelopes through them.
   */
  private async executeSteps(): Promise<void> {
    const runContext = this.runContext
    if (!runContext) throw new Error('Run not started')

    let stream: AsyncIterable<import('../types.js').Envelope<unknown>> | null = null

    // Helper: default stream of one empty envelope for tests/tool-only pipelines
    const createEmptyStream = async function* () {
      yield { item: {}, meta: {} }
    }

    for (const [stepIndex, step] of this.pipeline.steps.entries()) {
      // Pause if signaled
      while (this.stateMachine.current === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (this.stateMachine.current !== 'running') break

      const stepId = `${step.type}-${step.config.name ?? step.type}-${Date.now()}`

      this.logger().info(`Configuring pipeline stream for step: ${step.type} (${stepId})`)

      switch (step.type) {
        case 'source': {
          const uri = step.config.uri as string
          const source = registry.resolveSource(uri)
          stream = source.start({ run: runContext })
          break
        }
        case 'tool': {
          const toolName = step.config.name as string
          const tool = step.config.tool as import('../types.js').Tool<unknown, unknown> | undefined

          const _concurrency = Number.parseInt(
            (step.config.concurrency as string) ??
              this.globalContext.defaults.concurrency.toString(),
            10,
          )
          const retryPolicy =
            (step.config.retry as RetryPolicy) ?? this.pipeline.retry ?? this.globalContext.defaults.retry
          const onError =
            (step.config.onError as ErrorPolicy) ??
            this.pipeline.onError ??
            this.globalContext.defaults.onError

          const sourceStream: AsyncIterable<import('../types.js').Envelope<unknown>> =
            stream ?? createEmptyStream()
          const cache = this.cache
          const logger = this.logger()
          const store = this.store

          stream = (async function* (): AsyncGenerator<import('../types.js').Envelope<unknown>> {
            for await (const env of sourceStream) {
              if (!tool) {
                yield env
                continue
              }

              const cacheKey = tool.cacheable
                ? cache.computeKey({
                    toolName: tool.name,
                    version: tool.version,
                    input: env,
                    context: step.config.context as Record<string, unknown>,
                  })
                : null

              if (cacheKey && (await cache.has(cacheKey))) {
                logger.info(`Cache hit for tool ${tool.name}`)
                const cached = await cache.get<import('../types.js').Envelope<unknown>>(cacheKey)
                if (cached !== undefined) {
                  yield cached
                  continue
                }
              }

              try {
                const output = await withRetry(
                  async () => {
                    if (tool.exec && tool.exec !== 'inproc') {
                      return await runChildProcess({ command: tool.exec, args: [tool.name] }, env, {
                        run: runContext,
                        step: { stepId, name: toolName, type: 'tool', index: stepIndex },
                      })
                    }
                    return await tool.invoke(env, {
                      run: runContext,
                      step: { stepId, name: toolName, type: 'tool', index: stepIndex },
                    })
                  },
                  retryPolicy,
                  (err, attempt) => {
                    logger.warn(`Tool ${toolName} failed (attempt ${attempt + 1}): ${err}`)
                  },
                )

                if (cacheKey && output !== undefined) {
                  await cache.set(
                    cacheKey,
                    {
                      toolName: tool.name,
                      version: tool.version,
                      input: env,
                      context: step.config.context as Record<string, unknown>,
                    },
                    output,
                  )
                }
                yield output
              } catch (error) {
                logger.error(`Tool ${toolName} failed after retries: ${error}`)
                if (onError === 'fail-run') {
                  throw error
                }
                if (onError === 'dead-letter') {
                  await writeDeadLetter(store, runContext.runId, env, error as Error, stepId)
                  logger.warn(`Tool ${toolName} failed, written to dead-letter queue: ${error}`)
                }
                if (onError === 'skip-item') {
                  logger.warn(`Tool ${toolName} failed, skipping item: ${error}`)
                }
              }
            }
          })()
          break
        }
        case 'target': {
          const uri = step.config.uri as string
          const target = registry.resolveTarget(uri)
          if (!stream) throw new Error('Target step requires a preceding stream')

          await target.open({ run: runContext })
          for await (const env of stream) {
            await target.write(env, { run: runContext })
          }
          await target.close({ run: runContext })

          // Check for auto-commit on close
          const parsed = registry.parse(uri)
          if (parsed.query.commit === 'on-close') {
            this.logger().info(`Auto-committing changes in: ${runContext.global.project.root}`)
            await autoCommit(runContext.global.project.root)
          }
          break
        }
        case 'flatmap': {
          const fn = step.config.fn as (item: unknown) => Promise<unknown[]>
          const sourceStream: AsyncIterable<import('../types.js').Envelope<unknown>> =
            stream ?? createEmptyStream()
          this.logger().info(`Configuring flatMap step: ${stepId}`)
          stream = (async function* (): AsyncGenerator<import('../types.js').Envelope<unknown>> {
            for await (const env of sourceStream) {
              const items = await fn(env.item)
              for (const item of items) {
                yield { item, meta: env.meta }
              }
            }
          })()
          break
        }
        case 'fork': {
          const subPipeline = step.config.pipeline as import('../types.js').Pipeline
          const sourceStream: AsyncIterable<import('../types.js').Envelope<unknown>> =
            stream ?? createEmptyStream()
          this.logger().info(`Configuring fork step: ${stepId}`)
          stream = (async function* (): AsyncGenerator<import('../types.js').Envelope<unknown>> {
            for await (const env of sourceStream) {
              let subStream: AsyncIterable<import('../types.js').Envelope<unknown>> =
                (async function* () {
                  yield env
                })()
              for (const [childStepIndex, childStep] of subPipeline.steps.entries()) {
                if (childStep.type === 'tool') {
                  const tool = childStep.config.tool as
                    | import('../types.js').Tool<unknown, unknown>
                    | undefined
                  if (tool) {
                    const childToolName = tool.name
                    subStream = (async function* () {
                      for await (const e of subStream) {
                        yield await tool.invoke(e, {
                          run: runContext,
                          step: {
                            stepId,
                            name: childToolName,
                            type: 'tool',
                            index: childStepIndex,
                          },
                        })
                      }
                    })()
                  }
                }
              }
              for await (const e of subStream) {
                yield e
              }
            }
          })()
          break
        }
        case 'tap': {
          const fn = step.config.fn as (item: unknown) => Promise<void>
          const sourceStream: AsyncIterable<import('../types.js').Envelope<unknown>> =
            stream ?? createEmptyStream()
          this.logger().info(`Configuring tap step: ${stepId}`)
          stream = (async function* (): AsyncGenerator<import('../types.js').Envelope<unknown>> {
            for await (const env of sourceStream) {
              await fn(env.item)
              yield env
            }
          })()
          break
        }
        default:
          this.logger().warn(`Unsupported pipeline step type in stream: ${step.type}`)
      }
    }

    // Drain stream if we ended without a target
    if (stream) {
      for await (const _ of stream) {
        // no-op
      }
    }
  }

  /**
   * Execute a single pipeline step.
   */
  private async executeStep(_step: PipelineStep, _stepId: string): Promise<void> {
    throw new Error('executeStep is deprecated. Use executeSteps stream flow instead.')
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
    await this.store.writeJson(stateData, 'runs', this.runId, 'state.json')
    await this.store.writeJson(this.runContext ?? {}, 'runs', this.runId, 'context.json')
  }

  /**
   * Create a run context for this execution.
   */
  private createRunContext(): RunContext {
    return {
      runId: this.runId ?? randomUUID(),
      pipelineId: this.pipeline.id,
      startedAt: new Date().toISOString(),
      global: this.globalContext,
      checkpoint: {
        stepId: this.checkpoint.stepId,
        depth: 0,
        path: [this.checkpoint.stepId],
      },
      logger: this.logger(),
    }
  }

  /**
   * Get or create the logger.
   */
  private logger(): Logger {
    // Default console logger
    return {
      info: (message: string, meta?: Record<string, unknown>) => {
        console.log(`[${new Date().toISOString()}] [INFO] ${message}`, meta ?? '')
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        console.warn(`[${new Date().toISOString()}] [WARN] ${message}`, meta ?? '')
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, meta ?? '')
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        if (process.env.MT_DEBUG) {
          console.debug(`[${new Date().toISOString()}] [DEBUG] ${message}`, meta ?? '')
        }
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
