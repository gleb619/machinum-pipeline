import type {
  BatchScope,
  Exchange,
  ParsedUri,
  RunContext,
  Source,
  SourceContext,
  Target,
  TargetContext,
} from '@mt/core'
import { registry } from '@mt/core'

/**
 * Batch-scope waypoints: the views of `.batch(opts, nested)`.
 *
 *   batch://group     source  the package as ONE exchange (`item` = `items[]`, members carried)
 *   batch://members   source  every member as its own exchange (own id / meta / variables)
 *   batch://return    target  hand a result back to the enclosing scope
 *
 * Unlike `batches://` (a process-global named buffer that hops a package between pipelines)
 * these are scope-LOCAL: they read/write the `RunContext.batchScope` the Runner attaches to the
 * nested run, so there is no global state, no namespace and no cleanup. Outside a batch scope
 * they fail fast. The sources define no `resume()`: scope state is in-memory, so a resumed run
 * re-forms the group and replays the nested pipeline for it.
 */

const SOURCE_VIEWS = ['group', 'members'] as const

function scopeOf(run: RunContext, uri: string): BatchScope {
  const scope = run.batchScope
  if (!scope) {
    throw new Error(`${uri} is only valid inside a batch scope: .batch(opts, nestedPipeline)`)
  }
  return scope
}

/** `batch://group` | `batch://members` source over the enclosing batch scope. */
export function createBatchScopeSource(uri: ParsedUri): Source<unknown> {
  const view = uri.host || uri.path
  if (!(SOURCE_VIEWS as readonly string[]).includes(view)) {
    throw new Error(
      `Unknown batch source '${uri.raw}' (Known: ${SOURCE_VIEWS.map((v) => `batch://${v}`).join(', ')})`,
    )
  }
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Exchange<unknown>> {
      const scope = scopeOf(ctx.run, uri.raw)
      if (view === 'group') yield scope.group()
      else yield* scope.members()
    },
  }
}

/** `batch://return` target: commit every written exchange to the enclosing batch scope. */
export function createBatchReturnTarget(uri: ParsedUri): Target<unknown> {
  const name = uri.host || uri.path
  if (name !== 'return') {
    throw new Error(`Unknown batch target '${uri.raw}' (Known: batch://return)`)
  }
  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      scopeOf(ctx.run, uri.raw)
    },
    async write(env: Exchange<unknown>, ctx: TargetContext): Promise<void> {
      scopeOf(ctx.run, uri.raw).commit(env)
    },
    async close(): Promise<void> {},
  }
}

registry.registerSource('batch', createBatchScopeSource)
registry.registerTarget('batch', createBatchReturnTarget)
