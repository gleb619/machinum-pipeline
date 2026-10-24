import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBareSpecifier, rewriteSpecifiers } from '../src/pipeline-loader.js'

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mt-loader-'))
  const dir = join(root, 'node_modules', 'sub-main', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'sub-main', 'package.json'),
    JSON.stringify({ name: 'sub-main', version: '1.0.0', main: 'lib/index.js' }),
  )
  writeFileSync(join(dir, 'index.js'), '')
  return root
}

describe('pipeline specifier rewriting', () => {
  const root = makeProject()

  it('detects bare specifiers', () => {
    expect(isBareSpecifier('zod')).toBe(true)
    expect(isBareSpecifier('@scope/pkg')).toBe(true)
    expect(isBareSpecifier('pkg/sub')).toBe(true)
    expect(isBareSpecifier('./relative')).toBe(false)
    expect(isBareSpecifier('../relative')).toBe(false)
    expect(isBareSpecifier('/absolute')).toBe(false)
    expect(isBareSpecifier('node:fs')).toBe(false)
  })

  it('rewrites a bare specifier to the resolved entry point', () => {
    const source = "import { v } from 'sub-main'\n"
    const rewritten = rewriteSpecifiers(source, root)
    expect(rewritten).toContain(join(root, 'node_modules', 'sub-main', 'lib', 'index.js'))
  })

  it('leaves relative imports, builtins and binary specifiers alone', () => {
    const source = [
      "import { helper } from '../lib/helper'",
      "import { writeFileSync } from 'node:fs'",
      "import { definePipeline } from 'mt'",
      "import { chapterDoc } from 'mt/tools'",
      "import { v } from 'not-installed'",
    ].join('\n')
    expect(rewriteSpecifiers(source, root)).toBe(source)
  })

  it('rewrites dynamic imports with a literal specifier', () => {
    const source = "const mod = await import('sub-main')\n"
    expect(rewriteSpecifiers(source, root)).toContain(
      join(root, 'node_modules', 'sub-main', 'lib', 'index.js'),
    )
  })
})
