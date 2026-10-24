import { describe, expect, it, vi } from 'vitest'
import type { RetryPolicy } from '../../src/contexts.js'
import { getBackoff, resolveRetryPolicy, withRetry } from '../../src/engine/retry.js'

describe('resolveRetryPolicy', () => {
  const defaults: RetryPolicy = { max: 0, backoffMs: 0, strategy: 'fixed' }

  it('inherits unset fields from the layer below (partial step override)', () => {
    const pipeline: RetryPolicy = { max: 3, backoffMs: 500, strategy: 'exp' }
    expect(resolveRetryPolicy({ backoffMs: 50 }, pipeline, defaults)).toEqual({
      max: 3,
      backoffMs: 50,
      strategy: 'exp',
    })
    expect(resolveRetryPolicy({ max: 2 }, pipeline, defaults)).toEqual({
      max: 2,
      backoffMs: 500,
      strategy: 'exp',
    })
    expect(resolveRetryPolicy({ strategy: 'linear' }, pipeline, defaults)).toEqual({
      max: 3,
      backoffMs: 500,
      strategy: 'linear',
    })
  })

  it('merges per field, step winning over pipeline winning over defaults', () => {
    expect(
      resolveRetryPolicy(
        { max: 1 },
        { backoffMs: 20, strategy: 'linear' },
        {
          max: 7,
          backoffMs: 70,
          strategy: 'exp',
        },
      ),
    ).toEqual({ max: 1, backoffMs: 20, strategy: 'linear' })
  })

  it('treats an explicit undefined field as unset rather than a value', () => {
    const pipeline: RetryPolicy = { max: 4, backoffMs: 250, strategy: 'linear' }
    expect(
      resolveRetryPolicy({ max: undefined, backoffMs: undefined }, pipeline, defaults),
    ).toEqual(pipeline)
  })

  it('falls through to defaults when no upper layer declares retry', () => {
    expect(resolveRetryPolicy(undefined, undefined, defaults)).toEqual(defaults)
  })

  it('rejects invalid values naming the offending field and layer', () => {
    const pipeline: RetryPolicy = { max: 3, backoffMs: 100, strategy: 'fixed' }

    expect(() => resolveRetryPolicy({ max: -1 }, pipeline, defaults)).toThrow(/max/)
    expect(() => resolveRetryPolicy({ max: 1.5 }, pipeline, defaults)).toThrow(/max/)
    expect(() => resolveRetryPolicy({ max: Number.NaN }, pipeline, defaults)).toThrow(/max/)
    expect(() => resolveRetryPolicy({ max: Number.POSITIVE_INFINITY }, pipeline, defaults)).toThrow(
      /max/,
    )
    expect(() => resolveRetryPolicy({ backoffMs: -5 }, pipeline, defaults)).toThrow(/backoffMs/)
    expect(() => resolveRetryPolicy({ backoffMs: Number.NaN }, pipeline, defaults)).toThrow(
      /backoffMs/,
    )
    expect(() => resolveRetryPolicy({ strategy: 'nope' as never }, pipeline, defaults)).toThrow(
      /strategy/,
    )
    expect(() => resolveRetryPolicy({ max: 2 }, pipeline, defaults)).not.toThrow()
  })

  it('names the layer a bad value came from', () => {
    expect(() =>
      resolveRetryPolicy(undefined, { max: 3, backoffMs: -1, strategy: 'fixed' }, defaults),
    ).toThrow('pipeline.retry')
  })

  it('rejects a retry layer that is not an object', () => {
    expect(() => resolveRetryPolicy('5' as never, undefined, defaults)).toThrow(/retry/i)
  })
})

describe('withRetry', () => {
  it('returns result on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    const policy: RetryPolicy = { max: 3, backoffMs: 10, strategy: 'fixed' }
    const result = await withRetry(fn, policy, () => {})
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on failure and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success')

    const policy: RetryPolicy = { max: 3, backoffMs: 1, strategy: 'fixed' }
    const onRetry = vi.fn()
    const result = await withRetry(fn, policy, onRetry)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries and throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    const policy: RetryPolicy = { max: 2, backoffMs: 1, strategy: 'fixed' }

    await expect(withRetry(fn, policy, () => {})).rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('still calls fn once when max is not a finite non-negative integer', async () => {
    for (const max of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const fn = vi.fn().mockResolvedValue('success')
      const policy = { max, backoffMs: 1, strategy: 'fixed' } as unknown as RetryPolicy

      await expect(withRetry(fn, policy, () => {})).resolves.toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  it('never waits a non-finite delay between attempts', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    const policy: RetryPolicy = { max: 2, backoffMs: Number.NaN, strategy: 'fixed' }

    await expect(withRetry(fn, policy, () => {})).rejects.toThrow('always fail')
    const delays = spy.mock.calls.map((args) => args[1])
    expect(delays.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0)).toBe(true)
    spy.mockRestore()
  })

  describe('error contract (retryable / retryAfterMs)', () => {
    it('does not retry an error that declares retryable: false', async () => {
      const spy = vi.spyOn(globalThis, 'setTimeout')
      const onRetry = vi.fn()
      const fn = vi.fn().mockRejectedValue(
        Object.assign(new Error('insufficient credits'), {
          retryable: false,
        }),
      )
      const policy: RetryPolicy = { max: 3, backoffMs: 1000, strategy: 'exp' }

      await expect(withRetry(fn, policy, onRetry)).rejects.toThrow('insufficient credits')
      expect(fn).toHaveBeenCalledTimes(1)
      expect(onRetry).not.toHaveBeenCalled()
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('honours retryable: false on a plain thrown object, not only Error instances', async () => {
      const fn = vi.fn().mockRejectedValue({ retryable: false, message: 'boom' })
      const policy: RetryPolicy = { max: 3, backoffMs: 1, strategy: 'fixed' }

      await expect(withRetry(fn, policy, () => {})).rejects.toBeTruthy()
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retries an error that says nothing about retryability', async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('ok')
      const policy: RetryPolicy = { max: 2, backoffMs: 1, strategy: 'fixed' }

      await expect(withRetry(fn, policy, () => {})).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('retries an error that declares retryable: true', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('503'), { retryable: true }))
        .mockResolvedValueOnce('ok')
      const policy: RetryPolicy = { max: 2, backoffMs: 1, strategy: 'fixed' }

      await expect(withRetry(fn, policy, () => {})).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('waits retryAfterMs instead of the computed backoff', async () => {
      const spy = vi.spyOn(globalThis, 'setTimeout')
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('429 slow down'), { retryable: true, retryAfterMs: 10 }),
        )
        .mockResolvedValueOnce('ok')
      const policy: RetryPolicy = { max: 1, backoffMs: 50, strategy: 'fixed' }

      await expect(withRetry(fn, policy, () => {})).resolves.toBe('ok')
      expect(spy.mock.calls.map((args) => args[1])).toEqual([10])
      spy.mockRestore()
    })

    it('clamps retryAfterMs to maxBackoffMs', async () => {
      const spy = vi.spyOn(globalThis, 'setTimeout')
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('429 slow down'), { retryable: true, retryAfterMs: 5000 }),
        )
        .mockResolvedValueOnce('ok')
      const policy: RetryPolicy = { max: 1, backoffMs: 1, strategy: 'fixed', maxBackoffMs: 5 }

      await expect(withRetry(fn, policy, () => {})).resolves.toBe('ok')
      expect(spy.mock.calls.map((args) => args[1])).toEqual([5])
      spy.mockRestore()
    })

    it('clamps a growing backoff to maxBackoffMs', async () => {
      const spy = vi.spyOn(globalThis, 'setTimeout')
      const fn = vi.fn().mockRejectedValue(new Error('always fail'))
      const policy: RetryPolicy = { max: 2, backoffMs: 20, strategy: 'exp', maxBackoffMs: 10 }

      await expect(withRetry(fn, policy, () => {})).rejects.toThrow('always fail')
      expect(spy.mock.calls.map((args) => args[1])).toEqual([10, 10])
      spy.mockRestore()
    })
  })
})

describe('getBackoff cap', () => {
  it('exponential growth is clamped to the default 60s ceiling', () => {
    const policy: RetryPolicy = { max: 5, backoffMs: 10_000, strategy: 'exp' }
    expect(getBackoff(0, policy)).toBe(10_000)
    expect(getBackoff(1, policy)).toBe(20_000)
    expect(getBackoff(2, policy)).toBe(40_000)
    expect(getBackoff(3, policy)).toBe(60_000)
    expect(getBackoff(9, policy)).toBe(60_000)
  })

  it('an explicit maxBackoffMs overrides the default ceiling', () => {
    const policy: RetryPolicy = { max: 5, backoffMs: 1000, strategy: 'linear', maxBackoffMs: 3000 }
    expect(getBackoff(0, policy)).toBe(1000)
    expect(getBackoff(1, policy)).toBe(2000)
    expect(getBackoff(2, policy)).toBe(3000)
    expect(getBackoff(3, policy)).toBe(3000)
  })
})

describe('resolveRetryPolicy — maxBackoffMs', () => {
  it('stays unset (engine default applies) when no layer declares it', () => {
    const policy: RetryPolicy = { max: 3, backoffMs: 500, strategy: 'exp' }
    expect(resolveRetryPolicy(undefined, undefined, policy)).toEqual(policy)
  })

  it('merges per field like the other knobs', () => {
    expect(
      resolveRetryPolicy(
        { maxBackoffMs: 2000 },
        { max: 2, backoffMs: 100, strategy: 'fixed', maxBackoffMs: 5000 },
        { max: 1, backoffMs: 10, strategy: 'linear' },
      ),
    ).toEqual({ max: 2, backoffMs: 100, strategy: 'fixed', maxBackoffMs: 2000 })
  })

  it('rejects an invalid maxBackoffMs naming the field and layer', () => {
    const defaults: RetryPolicy = { max: 0, backoffMs: 0, strategy: 'fixed' }
    expect(() =>
      resolveRetryPolicy(
        undefined,
        { max: 1, backoffMs: 1, strategy: 'fixed', maxBackoffMs: -1 },
        defaults,
      ),
    ).toThrow(/maxBackoffMs/)
    expect(() =>
      resolveRetryPolicy(
        { maxBackoffMs: Number.NaN },
        { max: 1, backoffMs: 1, strategy: 'fixed' },
        defaults,
      ),
    ).toThrow(/maxBackoffMs/)
  })
})
