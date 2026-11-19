import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootDir = resolve(import.meta.dirname, '..')
const packagesDir = join(rootDir, 'packages')

type Rule = 'defineTool' | 'waypoint'

interface Violation {
  packageName: string
  rule: Rule
  file: string
  line: number
  text: string
}

/**
 * Temporary grandfathers, keyed by `<package dir>:<rule>`. Keep this list as small as possible.
 *
 * TODO(docs/plans/bookkit-to-tools.md): move the `defineTool` implementations out of
 * `packages/bookkit/src` into `packages/tools/src`, then delete `bookkit:defineTool`.
 */
const KNOWN_VIOLATIONS = new Set<string>(['bookkit:defineTool'])

const TOOL_CALL = /\bdefineTool\b\s*(?:<[^(;]*>\s*)?\(/g
const WAYPOINT_CALL =
  /\b(?:defineSource|defineTarget|defineWaypoint|registerSource|registerTarget)\b\s*(?:<[^(;]*>\s*)?\(/g

const RULES: ReadonlyArray<{
  rule: Rule
  pattern: RegExp
  owners: ReadonlySet<string>
}> = [
  { rule: 'defineTool', pattern: TOOL_CALL, owners: new Set(['core', 'tools']) },
  { rule: 'waypoint', pattern: WAYPOINT_CALL, owners: new Set(['core', 'waypoint']) },
]

/** Existing `@mt/*` package names. Extending this family needs a plan and user approval. */
const KNOWN_MT_PACKAGES = new Set([
  '@mt/core',
  '@mt/cli',
  '@mt/tools',
  '@mt/waypoint',
  '@mt/router',
  '@mt/webui',
  '@mt/components',
  '@mt/tui',
  '@mt/mcp',
  '@mt/chrome-extension',
  '@mt/plugins',
])

/** Transitional package the guard tolerates until its tools move into `@mt/tools`. */
const GRANDFATHERED_PACKAGES = new Set(['@mt/bookkit'])

function collectTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      files.push(...collectTsFiles(fullPath))
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
    files.push(fullPath)
  }
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Blanks out comments and string/template bodies while preserving newlines, so calls quoted in
 * docs, generated skill text or test fixtures do not count as real registrations.
 */
function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < source.length) {
    const char = source.charAt(i)
    const next = source.charAt(i + 1)
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (char === "'") {
        state = 'single'
        out += ' '
        i += 1
        continue
      }
      if (char === '"') {
        state = 'double'
        out += ' '
        i += 1
        continue
      }
      if (char === '`') {
        state = 'template'
        out += ' '
        i += 1
        continue
      }
      out += char
      i += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        out += '\n'
      } else {
        out += char === '\r' ? '\r' : ' '
      }
      i += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += char === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    if (char === '\\') {
      out += ' '
      if (i + 1 < source.length) {
        out += next === '\n' ? '\n' : ' '
        i += 2
      } else {
        i += 1
      }
      continue
    }
    const closes =
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    if (closes) {
      state = 'code'
      out += ' '
      i += 1
      continue
    }
    out += char === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

function collectViolations(): Violation[] {
  const violations: Violation[] = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const srcDir = join(packagesDir, entry.name, 'src')
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue
    for (const file of collectTsFiles(srcDir)) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
      for (const { rule, pattern, owners } of RULES) {
        if (owners.has(entry.name)) continue
        pattern.lastIndex = 0
        for (const match of code.matchAll(pattern)) {
          violations.push({
            packageName: entry.name,
            rule,
            file,
            line: code.slice(0, match.index).split('\n').length,
            text: match[0].replace(/\s+/g, ' '),
          })
        }
      }
    }
  }
  return violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  )
}

function formatViolations(violations: Violation[]): string[] {
  return violations.map(
    (violation) =>
      `${relative(rootDir, violation.file)}:${violation.line} [${violation.rule}] ${violation.text}`,
  )
}

describe('package ownership', () => {
  it('keeps reusable Tool implementations in packages/tools', () => {
    const violations = collectViolations()
      .filter((violation) => violation.rule === 'defineTool')
      .filter((violation) => !KNOWN_VIOLATIONS.has(`${violation.packageName}:${violation.rule}`))
    expect(formatViolations(violations)).toEqual([])
  })

  it('keeps Source/Target/URI-scheme implementations in packages/waypoint', () => {
    const violations = collectViolations()
      .filter((violation) => violation.rule === 'waypoint')
      .filter((violation) => !KNOWN_VIOLATIONS.has(`${violation.packageName}:${violation.rule}`))
    expect(formatViolations(violations)).toEqual([])
  })

  it('does not introduce a new @mt/* package for pipeline glue', () => {
    const violations: string[] = []
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageJsonPath = join(packagesDir, entry.name, 'package.json')
      if (!existsSync(packageJsonPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
      if (!isRecord(parsed) || typeof parsed.name !== 'string') continue
      const name = parsed.name
      if (!name.startsWith('@mt/')) continue
      if (KNOWN_MT_PACKAGES.has(name) || GRANDFATHERED_PACKAGES.has(name)) continue
      violations.push(
        [
          `${relative(rootDir, packageJsonPath)}: ${name} is a new @mt/* package.`,
          'Reusable tools belong in @mt/tools, URI schemes in @mt/waypoint.',
          'A new package needs a design in docs/plans/ and explicit user approval.',
        ].join(' '),
      )
    }
    expect(violations.sort()).toEqual([])
  })
})
