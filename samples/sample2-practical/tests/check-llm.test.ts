import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_ENV, SAMPLE_DIR, TSX_BIN } from './helpers.js'

describe('check-llm', () => {
  it('prints the mock backend without touching the network', () => {
    const output = execFileSync(TSX_BIN, ['check-llm.ts'], {
      cwd: SAMPLE_DIR,
      encoding: 'utf-8',
      env: { ...BASE_ENV, MT_LLM_TOOL: 'mock' },
      timeout: 30_000,
    })
    expect(output).toContain('backend: mock')
  })
})
