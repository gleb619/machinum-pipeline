import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDirOf } from '../../server/utils/run-dir.js'

describe('runDirOf', () => {
  it('resolves a plain run id inside .mt/runs', () => {
    expect(runDirOf('r1')).toBe(join(process.cwd(), '.mt', 'runs', 'r1'))
  })

  it('accepts uuid-shaped ids', () => {
    const id = '3f6f8f0e-2b3a-4c3d-9e1f-2a4b6c8d0e1f'
    expect(runDirOf(id)).toBe(join(process.cwd(), '.mt', 'runs', id))
  })

  it.each([
    ['empty', ''],
    ['dot-dot', '..'],
    ['dot-dot substring', 'a..b'],
    ['posix separator', '../x'],
    ['nested posix separator', 'a/b'],
    ['windows separator', '..\\x'],
    ['nul byte', 'a\0b'],
  ])('rejects %s ids with 400', (_label, id) => {
    let caught: unknown
    try {
      runDirOf(id)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { statusCode?: number }).statusCode).toBe(400)
  })
})
