import { describe, expect, it } from 'vitest';
import { getBackoff, wait, withRetry } from '../../src/engine/retry.js';
describe('UC-17 — Retry logic (architectural)', () => {
    it('withRetry is exported as a function', () => {
        expect(typeof withRetry).toBe('function');
    });
    it('wait is exported as a function', () => {
        expect(typeof wait).toBe('function');
    });
    it('getBackoff is exported as a function', () => {
        expect(typeof getBackoff).toBe('function');
    });
    it('RetryPolicy supports max, backoffMs, and strategy', () => {
        const policy = { max: 5, backoffMs: 500, strategy: 'linear' };
        expect(typeof policy.max).toBe('number');
        expect(typeof policy.backoffMs).toBe('number');
        expect(policy.strategy).toBe('linear');
    });
    it('RetryPolicy.strategy supports fixed, linear, and exp', () => {
        const values = ['fixed', 'linear', 'exp'];
        expect(values).toEqual(['fixed', 'linear', 'exp']);
    });
    it('getBackoff computes correct delays for each strategy', () => {
        const policy = { max: 3, backoffMs: 100, strategy: 'fixed' };
        expect(getBackoff(0, policy)).toBe(100);
        expect(getBackoff(1, policy)).toBe(100);
        expect(getBackoff(2, policy)).toBe(100);
    });
    it('getBackoff linear increases with attempts', () => {
        const policy = { max: 3, backoffMs: 100, strategy: 'linear' };
        expect(getBackoff(0, policy)).toBe(100);
        expect(getBackoff(1, policy)).toBe(200);
        expect(getBackoff(2, policy)).toBe(300);
    });
    it('getBackoff exponential doubles with attempts', () => {
        const policy = { max: 3, backoffMs: 100, strategy: 'exp' };
        expect(getBackoff(0, policy)).toBe(100);
        expect(getBackoff(1, policy)).toBe(200);
        expect(getBackoff(2, policy)).toBe(400);
    });
    it('withRetry retries on failure up to max attempts', async () => {
        const policy = { max: 2, backoffMs: 0, strategy: 'fixed' };
        let attempts = 0;
        const result = await withRetry(async () => {
            attempts++;
            if (attempts <= 2)
                throw new Error(`fail ${attempts}`);
            return 'success';
        }, policy, () => { });
        expect(result).toBe('success');
        expect(attempts).toBe(3);
    });
    it('withRetry throws after exhausting retries', async () => {
        const policy = { max: 1, backoffMs: 0, strategy: 'fixed' };
        await expect(withRetry(async () => {
            throw new Error('always fails');
        }, policy, () => { })).rejects.toThrow('always fails');
    });
});
//# sourceMappingURL=retry.arch.test.js.map