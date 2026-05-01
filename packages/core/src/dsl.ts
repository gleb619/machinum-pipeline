import type { ToolContext } from './contexts.js'
import type { Envelope, Pipeline, PipelineStep, Source, Target, Tool } from './types.js'
import { registry } from './uri.js'

/**
 * DSL builder for defining a pipeline.
 * Chain: .from(source).use(tool).to(target)
 */
export function definePipeline<I = unknown, O = unknown>(config: {
  id: string
  retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
  onError: 'fail-run' | 'skip-item' | 'dead-letter'
}): PipelineBuilder<I, O> {
  return new PipelineBuilder<I, O>(config)
}

/**
 * Builder class for constructing a pipeline definition via a fluent API.
 */
export class PipelineBuilder<I, O> {
  private readonly id: string
  private readonly retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
  private readonly onError: 'fail-run' | 'skip-item' | 'dead-letter'
  private readonly steps: PipelineStep[] = []

  constructor(config: {
    id: string
    retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
    onError: 'fail-run' | 'skip-item' | 'dead-letter'
  }) {
    this.id = config.id
    this.retry = config.retry
    this.onError = config.onError
  }

  from<T>(source: Source<T>): PipelineBuilder<T, O> {
    this.steps.push({ type: 'source', config: { uri: source.uri } })
    return this as unknown as PipelineBuilder<T, O>
  }

  use<T, R>(
    tool: Tool<T, R>,
    overrides?: {
      retry?: { max?: number; backoffMs?: number; strategy?: 'fixed' | 'linear' | 'exp' }
    },
  ): PipelineBuilder<R, O> {
    this.steps.push({
      type: 'tool',
      config: {
        name: tool.name,
        version: tool.version,
        retry: overrides?.retry,
      },
    })
    return this as unknown as PipelineBuilder<R, O>
  }

  to<T>(target: Target<T>): Pipeline<I, O> {
    this.steps.push({ type: 'target', config: { uri: target.uri } })
    return this.build()
  }

  batch(size: number): PipelineBuilder<I[], O> {
    this.steps.push({ type: 'batch', config: { size } })
    return this as unknown as PipelineBuilder<I[], O>
  }

  window(size: number): PipelineBuilder<I[], O> {
    this.steps.push({ type: 'window', config: { size } })
    return this as unknown as PipelineBuilder<I[], O>
  }

  flatMap<R>(fn: (item: I) => Promise<R[]>): PipelineBuilder<R, O> {
    this.steps.push({ type: 'flatmap', config: { fn } })
    return this as unknown as PipelineBuilder<R, O>
  }

  fork(pipeline: Pipeline<I, any>): PipelineBuilder<I, O> {
    this.steps.push({ type: 'fork', config: { pipeline } })
    return this
  }

  tap(fn: (item: I) => Promise<void>): PipelineBuilder<I, O> {
    this.steps.push({ type: 'tap', config: { fn } })
    return this
  }

  private build(): Pipeline<I, O> {
    return {
      id: this.id,
      retry: this.retry,
      onError: this.onError,
      steps: this.steps,
    }
  }
}

/**
 * Define a tool.
 */
export function defineTool<I, O>(config: {
  name: string
  version: string
  invoke: (env: Envelope<I>, ctx: ToolContext) => Promise<Envelope<O>>
  exec?: 'inproc' | 'npx' | 'deno' | 'bun'
  cacheable?: boolean
  idempotent?: boolean
}): Tool<I, O> {
  return {
    name: config.name,
    version: config.version,
    invoke: config.invoke,
    exec: config.exec ?? 'inproc',
    cacheable: config.cacheable,
    idempotent: config.idempotent,
  }
}

/**
 * Define a source from a URI string.
 * Resolves the URI via the registry to find the appropriate source implementation.
 */
export function defineSource<T>(uri: string): Source<T> {
  return registry.resolveSource<T>(uri)
}

/**
 * Define a target from a URI string.
 * Resolves the URI via the registry to find the appropriate target implementation.
 */
export function defineTarget<T>(uri: string): Target<T> {
  return registry.resolveTarget<T>(uri)
}

/**
 * Shorthand: source(uri) — calls defineSource.
 */
export function source<T>(uri: string): Source<T> {
  return defineSource<T>(uri)
}

/**
 * Shorthand: target(uri) — calls defineTarget.
 */
export function target<T>(uri: string): Target<T> {
  return defineTarget<T>(uri)
}
