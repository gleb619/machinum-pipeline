import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFromNodeModules, resolvePackage } from '../src/node-resolve.js'

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mt-resolve-'))
  const pkg = (name: string, manifest: Record<string, unknown>, files: Record<string, string>) => {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    for (const [file, content] of Object.entries(files)) {
      const path = join(dir, file)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
    return dir
  }
  pkg('root-index', { name: 'root-index', version: '1.0.0', main: 'index.js' }, { 'index.js': '' })
  pkg(
    'sub-main',
    { name: 'sub-main', version: '1.0.0', main: 'lib/index.js' },
    {
      'lib/index.js': '',
    },
  )
  pkg(
    'exports-map',
    { name: 'exports-map', version: '1.0.0', exports: { '.': './lib/index.js' } },
    {
      'lib/index.js': '',
    },
  )
  pkg('no-manifest-main', { name: 'no-manifest-main', version: '1.0.0' }, { 'index.js': '' })
  pkg(
    '@scope/pkg',
    { name: '@scope/pkg', version: '1.0.0', main: 'lib/index.js' },
    {
      'lib/index.js': '',
    },
  )
  pkg('with-dep', { name: 'with-dep', version: '1.0.0', main: 'index.js' }, { 'index.js': '' })
  mkdirSync(join(root, 'node_modules', 'with-dep', 'node_modules', 'sub-main'), {
    recursive: true,
  })
  writeFileSync(
    join(root, 'node_modules', 'with-dep', 'node_modules', 'sub-main', 'package.json'),
    JSON.stringify({ name: 'sub-main', version: '1.0.0', main: 'lib/index.js' }),
  )
  mkdirSync(join(root, 'node_modules', 'with-dep', 'node_modules', 'sub-main', 'lib'), {
    recursive: true,
  })
  writeFileSync(
    join(root, 'node_modules', 'with-dep', 'node_modules', 'sub-main', 'lib', 'index.js'),
    '',
  )
  return root
}

describe('node package resolution', () => {
  const root = makeProject()

  it('finds a package whose entry point is at the package root', () => {
    const resolved = resolvePackage('root-index', root)
    expect(resolved?.entry).toBe(join(root, 'node_modules', 'root-index', 'index.js'))
  })

  it('finds a package whose main points into a subdirectory', () => {
    const resolved = resolvePackage('sub-main', root)
    expect(resolved?.entry).toBe(join(root, 'node_modules', 'sub-main', 'lib', 'index.js'))
  })

  it('finds a package behind an exports map', () => {
    const resolved = resolvePackage('exports-map', root)
    expect(resolved?.entry).toBe(join(root, 'node_modules', 'exports-map', 'lib', 'index.js'))
  })

  it('falls back to index.js when the manifest has no main', () => {
    const resolved = resolvePackage('no-manifest-main', root)
    expect(resolved?.entry).toBe(join(root, 'node_modules', 'no-manifest-main', 'index.js'))
  })

  it('finds scoped packages', () => {
    const resolved = resolvePackage('@scope/pkg', root)
    expect(resolved?.entry).toBe(join(root, 'node_modules', '@scope', 'pkg', 'lib', 'index.js'))
  })

  it('prefers the nested copy of a dependency', () => {
    const nested = join(root, 'node_modules', 'with-dep')
    const resolved = resolvePackage('sub-main', nested)
    expect(resolved?.entry).toBe(join(nested, 'node_modules', 'sub-main', 'lib', 'index.js'))
  })

  it('returns undefined for a package that is not installed', () => {
    expect(resolvePackage('not-installed', root)).toBeUndefined()
    expect(resolveFromNodeModules('not-installed', root)).toBeUndefined()
  })
})
