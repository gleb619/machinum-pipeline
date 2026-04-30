import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import pLimit from 'p-limit'
import type { Logger, Pipeline, PipelineStep, RunStateData } from '../types.js'
import type { GlobalContext, RunContext } from '../contexts.js'
import { Store } from '../store.js'
import { registry } from '../uri.js'
// Side-effect import: triggers builtin source/target registration
import '../builtins/jsonl-source.js'
import { RunStateMachine } from './state-machine.js'
import { createRootCheckpoint, findFirstNonDone, findNode, markDone, markFailed, markInProgress, serializeTree } from './checkpoint.js'
import { withRetry } from './retry.js'

/**
 * Runner — executes a pipeline definition, manages state machine, checkpointing, and logging.
 */
export class Runner {
  private readonly pipeline: Pipeline
  private readonly globalContext: GlobalContext
  private readonly store: Store
  private readonly stateMachine: RunStateMachine
  private runId: string | null = null
  private runContext: RunContext | null = null
  private checkpoint = createRootCheckpoint('root')

  constructor(pipeline: Pipeline, globalContext: GlobalContext) {
    this.pipeline = pipeline
    this.globalContext = globalContext
    this.store = new Store(join(globalContext.project.root, '.mt'))
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
   * Execute all pipeline steps sequentially.
   */
  private async executeSteps(): Promise<void> {
    const runContext = this.runContext
    if (!runContext) throw new Error('Run not started')

    for (const step of this.pipeline.steps) {
      if (this.stateMachine.current !== 'running') break

      const stepId = `${step.type}-${step.config.name ?? step.type}-${Date.now()}`
      const existing = findNode(this.checkpoint, stepId)

      if (existing?.state === 'done') {
        this.logger().info(`Step ${stepId} already done, skipping`)
        continue
      }

      markInProgress(existing ?? this.checkpoint)

      try {
        await this.executeStep(step, stepId)
        const node = findNode(this.checkpoint, stepId) ?? this.checkpoint
        markDone(node)
        await this.persistState()
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.logger().error(`Step ${stepId} failed: ${errorMessage}`)
        const node = findNode(this.checkpoint, stepId) ?? this.checkpoint
        markFailed(node, errorMessage)

        if (this.pipeline.onError === 'fail-run') {
          this.stateMachine.transition('failed')
          await this.persistState()
          throw error
        }
        // For skip-item or dead-letter, continue
        await this.persistState()
      }
    }
  }

  /**
   * Execute a single pipeline step.
   */
  private async executeStep(step: PipelineStep, stepId: string): Promise<void> {
    const runContext = this.runContext
    if (!runContext) throw new Error('Run not started')

    this.logger().info(`Executing step: ${step.type} (${stepId})`)

    switch (step.type) {
      case 'source': {
        const uri = step.config.uri as string
        const source = registry.resolveSource(uri)
        const sourceCtx = { run: runContext }
        for await (const _envelope of source.start(sourceCtx)) {
          // Source pushes items into the pipeline
          // For now, just acknowledge
          this.logger().debug(`Source emitted item from ${uri}`)
        }
        break
      }
      case 'tool': {
        const concurrency = Number.parseInt((step.config.concurrency as string) ?? this.globalContext.defaults.concurrency.toString(), 10)
        const limit = pLimit(concurrency)
        const toolName = step.config.name as string
        const retryPolicy = (step.config.retry as any) ?? this.pipeline.retry ?? this.globalContext.defaults.retry
        const onError = (step.config.onError as any) ?? this.pipeline.onError ?? this.globalContext.defaults.onError

        this.logger().info(`Tool step: ${toolName} (concurrency: ${concurrency})`)

        await limit(async () => {
          try {
            await withRetry(
              async () => {
                this.logger().debug(`Executing tool: ${toolName}`)
                // Placeholder for actual tool invocation logic
              },
              retryPolicy,
              (err, attempt) => {
                this.logger().warn(`Tool ${toolName} failed (attempt ${attempt + 1}): ${err}`)
              }
            )
          } catch (error) {
            this.logger().error(`Tool ${toolName} failed after retries: ${error}`)
            if (onError === 'fail-run') {
              throw error
            }
            if (onError === 'dead-letter') {
              this.logger().error(`Sending failed envelope to dead-letter for tool ${toolName}`)
              // Logic for dead-letter persistence would go here
            }
          }
        })
        break
      }
      case 'target': {
        const uri = step.config.uri as string
        const target = registry.resolveTarget(uri)
        const targetCtx = { run: runContext }
        await target.open(targetCtx)
        this.logger().info(`Target opened: ${uri}`)
        await target.close(targetCtx)
        this.logger().info(`Target closed: ${uri}`)
        break
      }
      case 'tap': {
        const fn = step.config.fn as (item: any) => Promise<void>
        this.logger().debug(`Executing tap`)
        // Tap is a non-mutating side effect
        break
      }
      case 'flatmap': {
        const fn = step.config.fn as (item: any) => Promise<any[]>
        this.logger().debug(`Executing flatmap`)
        // Flatmap logic would go here
        break
      }
      case 'fork': {
        const pipeline = step.config.pipeline as Pipeline
        this.logger().info(`Executing fork for pipeline: ${pipeline.id}`)
        // Fork logic would instantiate a nested runner
        break
      }
      case 'batch':
      case 'window':
        this.logger().debug(`DSL operator step: ${step.type}`)
        break
      default: {
        throw new Error(`Unknown step type: ${step.type}`)
      }
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
