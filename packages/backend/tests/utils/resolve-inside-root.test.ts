import { describe, expect, it } from 'vitest'
import { PathOutsideRootError, resolveInsideRoot } from '../../server/utils/resolve-inside-root.js'

const ROOT = '/project/root'

describe('resolveInsideRoot', () => {
  it('resolves a relative path inside the root', () => {
    expect(resolveInsideRoot(ROOT, 'pipelines/a.mjs')).toBe('/project/root/pipelines/a.mjs')
  })

  it('accepts an absolute path inside the root', () => {
    expect(resolveInsideRoot(ROOT, '/project/root/pipelines/a.mjs')).toBe(
      '/project/root/pipelines/a.mjs',
    )
  })

  it('accepts a path that stays inside after dot segments', () => {
    expect(resolveInsideRoot(ROOT, 'pipelines/../a.mjs')).toBe('/project/root/a.mjs')
  })

  it('resolves the root itself for "."', () => {
    expect(resolveInsideRoot(ROOT, '.')).toBe('/project/root')
  })

  it('rejects a relative path that escapes the root', () => {
    expect(() => resolveInsideRoot(ROOT, '../evil.mjs')).toThrow(PathOutsideRootError)
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveInsideRoot(ROOT, '/other/evil.mjs')).toThrow(PathOutsideRootError)
  })

  it('rejects a nested traversal that escapes the root', () => {
    expect(() => resolveInsideRoot(ROOT, 'a/b/../../../evil.mjs')).toThrow(PathOutsideRootError)
  })
})
