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
})
