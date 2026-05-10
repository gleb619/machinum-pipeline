import type { ToolContext } from './contexts.js'
import type { Envelope, Pipeline, PipelineStep, Source, Target, Tool } from './types.js'
import { registry } from './uri.js'
import { basename, dirname } from 'path'

/**
 * Default retry configuration
 */
const DEFAULT_RETRY = { max: 3, backoffMs: 1000, strategy: 'exp' as const }
const DEFAULT_ON_ERROR: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run'

/**
 * Extract pipeline ID from caller filename using stack trace analysis.
 * Falls back to 'default-pipeline' if unable to determine.
 */
function getCallerFileId(): string {
  const originalPrepareStackTrace = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_, stack) => stack
    const err = new Error()
    const stack = err.stack as unknown as NodeJS.CallSite[]
    
    // Find the caller (skip this function, getCallerFileId, and the definePipeline call)
    for (let i = 2; i < stack.length; i++) {
      const caller = stack[i]
      if (!caller) continue
      const fileName = caller.getFileName()
      if (fileName && fileName.endsWith('.ts') && !fileName.includes('node_modules')) {
        // Extract filename without extension
        const base = basename(fileName, '.ts')
        // Skip index files, use parent directory name if it's a common pattern
        if (base === 'index' || base === 'pipeline') {
          const dirName = basename(dirname(fileName))
          return dirName
        }
        return base
      }
    }
  } catch {
    // Fallback
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace
  }
  return 'default-pipeline'
}

/**
 * DSL builder for defining a pipeline.
 * Chain: .from(source).use(tool).to(target)
 * Also supports .fork() and .subflow() for branching logic.
 * 
 * @param config - Optional configuration. If omitted, uses defaults:
 *   - id: derived from filename (e.g., 'my-pipeline' from 'my-pipeline.ts')
 *   - retry: { max: 3, backoffMs: 1000, strategy: 'exp' }
 *   - onError: 'fail-run'
 * 
 * @example
 * // Full config
 * definePipeline({
 *   id: 'my-pipeline',
 *   retry: { max: 5, backoffMs: 2000, strategy: 'linear' },
 *   onError: 'skip-item'
 * })
 * 
 * @example
 * // With defaults (id derived from filename)
 * definePipeline()
 *   .from('jsonl://./input.jsonl')
 *   .to('md://./output.md')
 */
export function definePipeline<I = unknown, O = unknown>(config?: {
  id?: string
  retry?: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
  onError?: 'fail-run' | 'skip-item' | 'dead-letter'
}): PipelineBuilder<I, O> {
  const id = config?.id ?? getCallerFileId()
  const retry = config?.retry ?? DEFAULT_RETRY
  const onError = config?.onError ?? DEFAULT_ON_ERROR
  return new PipelineBuilder<I, O>({ id, retry, onError })
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

  /**
   * Set the source for the pipeline.
   * @param source - Source instance OR URI string (sugar)
   * 
   * @example
   * // Using Source instance
   * .from(source('jsonl://./input.jsonl'))
   * 
   * @example
   * // Using URI string (sugar)
   * .from('jsonl://./input.jsonl')
   */
  from<T>(source: Source<T> | string): PipelineBuilder<T, O> {
    const resolvedSource = typeof source === 'string' ? registry.resolveSource<T>(source) : source
    this.steps.push({ type: 'source', config: { uri: resolvedSource.uri } })
    return this as unknown as PipelineBuilder<T, O>
  }

  use<T, R>(
    tool: Tool<T, R>,
    overrides?: {
      retry?: { max?: number; backoffMs?: number; strategy?: 'fixed' | 'linear' | 'exp' }
      onError?: 'fail-run' | 'skip-item' | 'dead-letter'
    },
  ): PipelineBuilder<R, O> {
    this.steps.push({
      type: 'tool',
      config: {
        name: tool.name,
        version: tool.version,
        tool,
        retry: overrides?.retry,
        onError: overrides?.onError,
      },
    })
    return this as unknown as PipelineBuilder<R, O>
  }

  /**
   * Set the target for the pipeline.
   * @param target - Target instance OR URI string (sugar)
   * 
   * @example
   * // Using Target instance
   * .to(target('md://./output.md'))
   * 
   * @example
   * // Using URI string (sugar)
   * .to('md://./output.md')
   */
  to<T>(target: Target<T> | string): Pipeline<I, O> {
    const resolvedTarget = typeof target === 'string' ? registry.resolveTarget<T>(target) : target
    this.steps.push({ type: 'target', config: { uri: resolvedTarget.uri } })
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

  subflow(pipeline: Pipeline<I, any>): PipelineBuilder<I, O> {
    this.steps.push({ type: 'subflow', config: { pipeline } })
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
