import { describe, expect, it, vi } from 'vitest'
import type { RetryPolicy } from '../../src/contexts.js'
import { withRetry } from '../../src/engine/retry.js'

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
})
