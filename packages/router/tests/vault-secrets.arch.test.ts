import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Repo guard: the vault holds real endpoints and keys, so no vault value may end up in a committed
 * document or example. The router is the component that reads the vault, so the guard lives here.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgDir, '..', '..')

/** Human-written documentation and example surface. */
const SCAN_ROOTS = ['docs', 'samples']
const ROOT_FILES = ['README.md']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.output', '.turbo', 'coverage'])

/**
 * `at kanban` rewrites the board rows and each row carries a plan provenance stamp, so this feature
 * cannot keep that file clean without breaking the kanban loop. Machine-managed, therefore excluded.
 */
const MACHINE_MANAGED = new Set([
  'docs/kanban.md',
  'docs/kanban-loop.md',
  'docs/kanban-compose.md',
  'docs/kanban-feeder-loop.md',
])

/** The real GPU host / vault entry of this workstation. Never commit it. */
const PRIVATE_HOSTS = ['borispc3']

/** Live-looking credentials. Placeholders are allowed. */
const LIVE_KEYS = [
  /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /sk-live-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
]
const PLACEHOLDER = /EXAMPLE|FAKE|PLACEHOLDER|YOUR[_-]?KEY|XXXX|<[^>]+>/i

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await collectFiles(path)))
    } else {
      files.push(path)
    }
  }
  return files
}

/** Every file of the documentation surface, machine-managed planning files excluded. */
async function docSurface(): Promise<string[]> {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    files.push(...(await collectFiles(join(repoRoot, root))))
  }
  for (const file of ROOT_FILES) files.push(join(repoRoot, file))
  return files.filter((file) => !MACHINE_MANAGED.has(relative(repoRoot, file)))
}

describe('committed vault values (architectural)', () => {
  it('the documentation surface holds no live credentials', async () => {
    const offenders: string[] = []
    for (const file of await docSurface()) {
      const text = await readFile(file, 'utf8')
      for (const pattern of LIVE_KEYS) {
        for (const match of text.matchAll(pattern)) {
          if (PLACEHOLDER.test(match[0])) continue
          offenders.push(`${relative(repoRoot, file)}: ${match[0].slice(0, 8)}…`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no vault file is committed', async () => {
    const offenders: string[] = []
    for (const file of await docSurface()) {
      const name = basename(file)
      if (name === 'vault.json' || name.endsWith('.vault.json'))
        offenders.push(relative(repoRoot, file))
    }
    expect(offenders).toEqual([])
  })

  it('the documentation surface names no private host', async () => {
    const offenders: string[] = []
    for (const file of await docSurface()) {
      const text = await readFile(file, 'utf8')
      for (const host of PRIVATE_HOSTS) {
        if (text.toLowerCase().includes(host.toLowerCase())) {
          offenders.push(`${relative(repoRoot, file)}: ${host}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the example vault ships placeholders only', async () => {
    const raw = await readFile(join(repoRoot, 'docs', 'vault.example.json'), 'utf8')
    const example = JSON.parse(raw) as {
      entries: Record<string, { apiKey?: string; apiKeys?: string[] }>
    }
    const values: string[] = []
    for (const entry of Object.values(example.entries)) {
      if (entry.apiKey) values.push(entry.apiKey)
      values.push(...(entry.apiKeys ?? []))
    }
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value).toMatch(PLACEHOLDER)
  })

  it('the vault files are gitignored', () => {
    for (const path of ['.mt/vault.json', 'vault.json', 'team.vault.json']) {
      let out = ''
      try {
        out = execFileSync('git', ['check-ignore', path], { cwd: repoRoot, encoding: 'utf8' })
      } catch {
        out = ''
      }
      expect(out.trim(), `${path} must be gitignored`).toBe(path)
    }
  })
})
