import { toExchange } from '../exchange.js'
import type {
  AroundInterceptor,
  AroundNext,
  Exchange,
  PipelineInterceptor,
  Tool,
  ToolContext,
} from '../types.js'

/**
 * Invoke a tool with the pipeline's interceptors wrapped around it.
 *
 * Order: all `before` interceptors run in registration order (each may swap the incoming
 * exchange), then the `around` interceptors nest like onion middleware — the first
 * registered is the outermost layer, `next` inside the last one invokes the tool — then all
 * `after` interceptors run in registration order on the tool's output (each may swap it).
 * Errors propagate to the caller (the step's retry/error policy), so a throwing `before`
 * or `around` skips the remaining chain including the tool invoke.
 */
export async function invokeWithInterceptors<I, O>(
  tool: Tool<I, O>,
  env: Exchange<I>,
  ctx: ToolContext,
  interceptors: readonly PipelineInterceptor[],
): Promise<Exchange<O>> {
  let current = env as Exchange<unknown>
  for (const interceptor of interceptors) {
    if (interceptor.kind !== 'before') continue
    const replaced = await interceptor.fn(current, ctx)
    if (replaced !== undefined && replaced !== null) current = replaced
  }

  const invokeTool: AroundNext = (ex) => tool.invoke(ex as Exchange<I>, ctx) as Promise<Exchange<O>>
  let next: AroundNext = invokeTool
  const arounds = interceptors.filter(
    (interceptor): interceptor is { kind: 'around'; fn: AroundInterceptor } =>
      interceptor.kind === 'around',
  )
  for (let index = arounds.length - 1; index >= 0; index--) {
    const around = arounds[index]
    if (!around) continue
    const inner = next
    next = (ex) => around.fn(ex, ctx, inner)
  }

  let output = toExchange(await next(current)) as Exchange<O>
  for (const interceptor of interceptors) {
    if (interceptor.kind !== 'after') continue
    const replaced = await interceptor.fn(output, ctx)
    if (replaced !== undefined && replaced !== null) output = replaced as Exchange<O>
  }
  return output
}
