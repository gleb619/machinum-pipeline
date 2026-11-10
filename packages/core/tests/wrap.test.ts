import { describe, expect, it, vi } from 'vitest'
import { StageError, defineStage, wrap } from '../src/wrap.js'
import type {
  StageAfterInterceptor,
  StageAroundInterceptor,
  StageBeforeInterceptor,
  StageInterceptor,
  StageResultEvent,
} from '../src/wrap.js'

type Ctx = { tag: string }

const ctx: Ctx = { tag: 'run-1' }

function events(...kinds: Array<'before' | 'after' | 'around'>) {
  const seen: string[] = []
  const interceptors: StageInterceptor[] = []
  for (const kind of kinds) {
    if (kind === 'around') {
      interceptors.push({
        kind: 'around',
        fn: async (event, next) => {
          seen.push(`around-before:${event.stage}`)
          const out = await next()
          seen.push(`around-after:${event.stage}`)
          return out
        },
      } satisfies StageAroundInterceptor)
    } else if (kind === 'before') {
      interceptors.push({
        kind,
        fn: (event) => {
          seen.push(`before:${event.stage}`)
        },
      } satisfies StageBeforeInterceptor)
    } else {
      interceptors.push({
        kind,
        fn: (event) => {
          seen.push(`after:${event.stage}`)
        },
      } satisfies StageAfterInterceptor)
    }
  }
  return { seen, interceptors }
}

describe('wrap', () => {
  it('runs stages sequentially, feeding each output to the next', async () => {
    const chain = wrap<number, string, Ctx>(
      'math',
      defineStage('double', (n) => n * 2),
      defineStage('to-string', (n) => `n=${n}`),
    )
    await expect(chain(21, ctx)).resolves.toBe('n=42')
  })

  it('awaits sync stage fns and forwards the caller ctx unchanged to every stage', async () => {
    const received: Ctx[] = []
    const chain = wrap<string, string, Ctx>(
      'ctx',
      defineStage('a', (s, c) => {
        received.push(c)
        return `${s}a`
      }),
      defineStage('b', async (s, c) => {
        received.push(c)
        return `${s}b`
      }),
    )
    await expect(chain('', ctx)).resolves.toBe('ab')
    expect(received).toEqual([ctx, ctx])
  })

  it('runs before interceptors in order, then around-onion, then after', async () => {
    const { seen, interceptors } = events('before', 'around', 'after')
    const chain = wrap<number, number, Ctx>(
      'order',
      defineStage('one', (n) => n + 1),
      defineStage('two', (n) => n + 1),
    )
    for (const interceptor of interceptors) chain.intercept(interceptor)
    await expect(chain(0, ctx)).resolves.toBe(2)
    expect(seen).toEqual([
      'before:one',
      'around-before:one',
      'around-after:one',
      'after:one',
      'before:two',
      'around-before:two',
      'around-after:two',
      'after:two',
    ])
  })

  it('nests multiple around interceptors onion-style, first registered outermost', async () => {
    const seen: string[] = []
    const chain = wrap<number, number, Ctx>(
      'onion',
      defineStage('core', (n) => n + 1),
    )
    chain.intercept({
      kind: 'around',
      fn: async (_event, next) => {
        seen.push('outer-in')
        const out = (await next()) as number
        seen.push('outer-out')
        return out + 10
      },
    })
    chain.intercept({
      kind: 'around',
      fn: async (_event, next) => {
        seen.push('inner-in')
        const out = (await next()) as number
        seen.push('inner-out')
        return out * 2
      },
    })
    // core: 0+1=1 -> inner: 1*2=2 -> outer: 2+10=12
    await expect(chain(0, ctx)).resolves.toBe(12)
    expect(seen).toEqual(['outer-in', 'inner-in', 'inner-out', 'outer-out'])
  })

  it('lets a before interceptor replace the input and an after interceptor replace the output', async () => {
    const chain = wrap<number, number, Ctx>(
      'replace',
      defineStage('id', (n) => n),
    )
    chain.intercept({ kind: 'before', fn: () => 100 })
    chain.intercept({
      kind: 'after',
      fn: (event) => (event as StageResultEvent<number, number>).output + 1,
    })
    await expect(chain(0, ctx)).resolves.toBe(101)
  })

  it('lets an around interceptor short-circuit by not calling next', async () => {
    const chain = wrap<number, number, Ctx>(
      'short',
      defineStage('boom', () => {
        throw new Error('must not run')
      }),
    )
    chain.intercept({ kind: 'around', fn: async () => 42 })
    await expect(chain(0, ctx)).resolves.toBe(42)
  })

  it('includes per-stage timing in the after hook payload', async () => {
    let payload: StageResultEvent | undefined
    const chain = wrap<number, number, Ctx>(
      'timed',
      defineStage('slow', async (n) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return n
      }),
    )
    chain.intercept({
      kind: 'after',
      fn: (event) => {
        payload = event as StageResultEvent
      },
    })
    await chain(1, ctx)
    expect(payload).toBeDefined()
    expect(payload?.outcome).toBe('ok')
    expect(payload?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload?.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof payload?.durationMs).toBe('number')
  })

  it('attributes a stage error to its stage, skips later stages, and keeps the cause', async () => {
    const later = vi.fn()
    const chain = wrap<number, number, Ctx>(
      'failing',
      defineStage('ok', (n) => n),
      defineStage('bad', () => {
        throw new Error('kaboom')
      }),
      defineStage('later', later),
    )
    const failure = await chain(1, ctx).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StageError)
    const stageError = failure as StageError
    expect(stageError.stage).toBe('bad')
    expect(stageError.index).toBe(1)
    expect(stageError.path).toEqual(['failing'])
    expect(stageError.message).toBe("Stage 'failing/bad' failed: kaboom")
    expect(stageError.cause).toBeInstanceOf(Error)
    expect((stageError.cause as Error).message).toBe('kaboom')
    expect(later).not.toHaveBeenCalled()
  })

  it('carries retryable duck-typed fields from the cause onto the StageError', async () => {
    const chain = wrap<number, number, Ctx>(
      'retry',
      defineStage('rl', () => {
        throw Object.assign(new Error('rate limited'), {
          retryable: false,
          retryAfterMs: 2500,
        })
      }),
    )
    const failure = await chain(0, ctx).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StageError)
    expect((failure as StageError).retryable).toBe(false)
    expect((failure as StageError).retryAfterMs).toBe(2500)
  })

  it('rethrows a nested chain StageError with its own deeper path intact', async () => {
    const inner = wrap<number, number, Ctx>(
      'inner',
      defineStage('deep', () => {
        throw new Error('deep failure')
      }),
    )
    const outer = wrap<number, number, Ctx>(
      'outer',
      defineStage('call-inner', (n, c) => inner(n, c)),
    )
    const failure = await outer(0, ctx).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StageError)
    expect((failure as StageError).path).toEqual(['outer', 'inner'])
    expect((failure as StageError).stage).toBe('deep')
  })

  it('reports the full nested path in hook events', async () => {
    const paths: string[][] = []
    const inner = wrap<number, number, Ctx>(
      'inner',
      defineStage('deep', (n) => n + 1),
    )
    inner.intercept({
      kind: 'before',
      fn: (event) => {
        paths.push([...event.path])
      },
    })
    const outer = wrap<number, number, Ctx>(
      'outer',
      defineStage('call-inner', (n, c) => inner(n, c)),
    )
    await expect(outer(0, ctx)).resolves.toBe(1)
    expect(paths).toEqual([['outer', 'inner']])
  })

  it('reports disjoint paths for two interleaved chains (no path leakage)', async () => {
    const seenPaths: string[][] = []
    const makeChain = (name: string, delayMs: number) => {
      const chain = wrap<number, number, Ctx>(
        name,
        defineStage('work', async (n) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          return n
        }),
      )
      chain.intercept({
        kind: 'after',
        fn: (event) => {
          seenPaths.push([...(event as StageResultEvent).path])
        },
      })
      return chain
    }
    const a = makeChain('aaa', 5)
    const b = makeChain('bbb', 1)
    await Promise.all([a(1, ctx), b(2, ctx)])
    expect(seenPaths).toContainEqual(['aaa'])
    expect(seenPaths).toContainEqual(['bbb'])
    expect(seenPaths).toHaveLength(2)
  })

  it('calls straight through with no interceptors registered', async () => {
    const fn = vi.fn((n: number) => n + 1)
    const chain = wrap<number, number, Ctx>('bare', defineStage('only', fn))
    await expect(chain(1, ctx)).resolves.toBe(2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('validates name and stages at definition time', () => {
    expect(() => wrap('  ')).toThrow(TypeError)
    expect(() => wrap('empty')).toThrow(/at least one stage/)
    expect(() => defineStage('', () => 1)).toThrow(TypeError)
    expect(() => defineStage('x', 'not-a-fn' as never)).toThrow(TypeError)
  })
})
