import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getMonthlyCost } from '../server/utils/cost-tracker.js'
import { setRouterConfig } from '../server/utils/router-config.js'

function logLine(cost: number): string {
  return `${JSON.stringify({
    timestamp: '2026-10-31T22:30:00.000Z',
    runId: null,
    stepId: null,
    model: 'm',
    promptTokens: 0,
    completionTokens: 0,
    cost,
  })}\n`
}

describe('getMonthlyCost', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-cost-'))
    setRouterConfig({ logDir: dir })
    // Day dirs are UTC dates (`logCall` writes `<YYYY-MM-DD>` from `toISOString()`).
    await mkdir(join(dir, '2026-09-30'), { recursive: true })
    await writeFile(join(dir, '2026-09-30', 'log.jsonl'), logLine(4))
    await mkdir(join(dir, '2026-10-31'), { recursive: true })
    await writeFile(join(dir, '2026-10-31', 'log.jsonl'), logLine(1.5))
    await mkdir(join(dir, '2026-11-01'), { recursive: true })
    await writeFile(join(dir, '2026-11-01', 'log.jsonl'), logLine(2.5))
  })

  afterAll(async () => {
    setRouterConfig()
    await rm(dir, { recursive: true, force: true })
  })

  it('uses the UTC month, not the local-time month (east of UTC)', async () => {
    // 2026-10-31T22:30Z is 2026-11-01 03:30 in Asia/Karachi: the spend is still October's.
    const res = await getMonthlyCost(new Date('2026-10-31T22:30:00Z'))
    expect(res.calls).toBe(1)
    expect(res.totalCost).toBeCloseTo(1.5, 6)
  })

  it('uses the UTC month, not the local-time month (west of UTC)', async () => {
    // 2026-11-01T02:30Z is 2026-10-31 19:30 in America/Los_Angeles: the spend is November's.
    const res = await getMonthlyCost(new Date('2026-11-01T02:30:00Z'))
    expect(res.calls).toBe(1)
    expect(res.totalCost).toBeCloseTo(2.5, 6)
  })

  it('defaults to the current time', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-31T22:30:00Z'))
      const res = await getMonthlyCost()
      expect(res.calls).toBe(1)
      expect(res.totalCost).toBeCloseTo(1.5, 6)
    } finally {
      vi.useRealTimers()
    }
  })
})
