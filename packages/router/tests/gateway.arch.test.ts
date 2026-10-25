import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { redact } from '../server/utils/redact.js'

/**
 * The router is a keyless gateway: clients authenticate with the router token (or not at all), never
 * with an upstream key. These tests pin that shape on the source level — the live behaviour is
 * covered by `security.test.ts`.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(pkgDir, 'server')
const routesDir = join(srcDir, 'routes')

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/** Client headers that must never be forwarded upstream. */
const CLIENT_CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'cookie']

describe('keyless gateway (architectural)', () => {
  it('proxy handlers never read client credentials', async () => {
    for (const file of await collectFiles(routesDir)) {
      const source = await readFile(file, 'utf8')
      const rel = relative(srcDir, file)
      for (const header of CLIENT_CREDENTIAL_HEADERS) {
        expect(source, `${rel} must not read the client '${header}' header`).not.toMatch(
          new RegExp(`getHeader\\(\\s*event\\s*,\\s*['"\`]${header}['"\`]`, 'i'),
        )
      }
      expect(source, `${rel} must not copy the client headers wholesale`).not.toMatch(
        /event\.headers/,
      )
    }
  })

  it('the proxy builds upstream headers from scratch', async () => {
    const source = await readFile(join(routesDir, 'api', 'chat', 'completions.ts'), 'utf8')
    expect(source).toContain("'Content-Type': 'application/json'")
    expect(source).toMatch(/headers\.Authorization\s*=\s*`Bearer \$\{client\.apiKey\}`/)
  })

  it('router sources contain no key literals', async () => {
    const offenders: string[] = []
    for (const file of await collectFiles(srcDir)) {
      const source = await readFile(file, 'utf8')
      source.split('\n').forEach((line, index) => {
        if (/sk-(?:or-v1|live|proj)-[A-Za-z0-9_-]{8,}/.test(line)) {
          offenders.push(`${relative(srcDir, file)}:${index + 1} key literal`)
        }
        if (/(?:apiKey|apiKeys)\s*[:=]\s*['"`][^'"`]+['"`]/.test(line)) {
          offenders.push(`${relative(srcDir, file)}:${index + 1} hardcoded key`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('the redaction util exists and scrubs credentials', async () => {
    const source = await readFile(join(srcDir, 'utils', 'redact.ts'), 'utf8')
    expect(source).toContain('export function redact')
    expect(source).toContain('export function redactError')
    expect(redact('Bearer tok_abcdef123456')).toBe('Bearer ***')
    expect(redact('sk-live_abcdef123456')).toBe('***')
  })

  it('the auth middleware compares the router token in constant time', async () => {
    const source = await readFile(join(srcDir, 'middleware', 'auth.ts'), 'utf8')
    expect(source).toContain('timingSafeEqual')
    expect(source).toContain('Bearer')
  })

  it('the bind guard names the token it demands', async () => {
    const source = await readFile(join(srcDir, 'utils', 'bind-guard.ts'), 'utf8')
    expect(source).toContain('MT_ROUTER_TOKEN')
    expect(source).toContain('Refusing to bind')
  })
})
