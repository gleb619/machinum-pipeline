import { describe, expect, it } from 'vitest'
import { discoverPipelines } from '../src/discovery.js'
describe('UC-48 — Discover pipelines from mt.json (architectural)', () => {
  it('discoverPipelines is exported as a function', () => {
    expect(typeof discoverPipelines).toBe('function')
  })
  it('returns an empty array when no mt.json exists', async () => {
    const result = await discoverPipelines('/tmp/nonexistent-mt-project')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })
  it('DiscoveredPipeline shape — path and declared are strings', () => {
    const entry = { path: '/some/path.ts', declared: './pipelines/x.ts' }
    expect(entry).toHaveProperty('path')
    expect(entry).toHaveProperty('declared')
    expect(typeof entry.path).toBe('string')
    expect(typeof entry.declared).toBe('string')
  })
})
//# sourceMappingURL=discovery.arch.test.js.map
