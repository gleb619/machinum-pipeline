import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootDir = resolve(import.meta.dirname, '..')
const rootPackageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

function samplesWithTestScript(): string[] {
  return readdirSync(join(rootDir, 'samples'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try {
        const pkg = JSON.parse(
          readFileSync(join(rootDir, 'samples', entry.name, 'package.json'), 'utf8'),
        ) as { scripts?: Record<string, string> }
        return typeof pkg.scripts?.test === 'string'
      } catch {
        return false
      }
    })
    .map((entry) => entry.name)
    .sort()
}

describe('root test script parity', () => {
  it('invokes every sample that has a test script', () => {
    const testScript = rootPackageJson.scripts.test
    expect(testScript).toBeDefined()
    const samples = samplesWithTestScript()
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(testScript).toContain(`pnpm -C samples/${sample} run test`)
    }
  })
})
