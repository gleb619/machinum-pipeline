import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SyncFileTooLargeError,
  SyncProtectedPathError,
  SyncSymlinkError,
  buildManifest,
  collectOutputScope,
  collectSyncScope,
  createSyncHashCache,
  deleteSyncFile,
  diffManifests,
  isProtectedSyncPath,
  matchesGlob,
  pruneSyncFiles,
  readSyncFile,
  writeSyncFile,
} from '../src/index.js'

// Kept local: the public config reader is exercised through the real config test.
import { readMtConfig } from '../src/config.js'

async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-sync-'))
  await mkdir(join(dir, 'pipelines'), { recursive: true })
  await mkdir(join(dir, 'lib'), { recursive: true })
  await mkdir(join(dir, 'input'), { recursive: true })
  await mkdir(join(dir, 'out'), { recursive: true })
  await mkdir(join(dir, '.mt', 'runs', 'r1'), { recursive: true })
  await mkdir(join(dir, '.mt', 'vault'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'mt.json'),
    JSON.stringify({ project: { name: 'fixture' }, pipelines: ['./pipelines/main.ts'] }),
  )
  await writeFile(
    join(dir, 'pipelines', 'main.ts'),
    [
      "import { helper } from '../lib/helper.js'",
      'export default { from: \'.from("jsonl://./input/ch1.jsonl")\', to: \'.to("md://./out")\' }',
      'void helper',
    ].join('\n'),
  )
  await writeFile(join(dir, 'lib', 'helper.ts'), "import './nested.js'\nexport const helper = 1\n")
  await writeFile(join(dir, 'lib', 'nested.ts'), 'export const nested = 1\n')
  await writeFile(join(dir, 'input', 'ch1.jsonl'), '{"item":"hello"}\n')
  await writeFile(join(dir, 'out', 'ch1.md'), '# result\n')
  await writeFile(join(dir, '.mt', 'runs', 'r1', 'state.json'), '{"state":"done"}')
  await writeFile(join(dir, '.mt', 'vault', 'secret.txt'), 'nope')
  await writeFile(join(dir, '.env'), 'SECRET=nope')
  await writeFile(join(dir, '.env.local'), 'SECRET=nope')
  await writeFile(join(dir, 'vault.json'), '{}')
  await writeFile(join(dir, 'secrets.kdbx'), 'nope')
  await writeFile(join(dir, '.git', 'config'), 'nope')
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'nope')
  await writeFile(join(dir, 'dist', 'bundle.js'), 'nope')
  return dir
}

describe('sync scope', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fixtureRoot()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('matches ** and basename globs', () => {
    expect(matchesGlob('pipelines/a.ts', 'pipelines/**')).toBe(true)
    expect(matchesGlob('pipelines/deep/a.ts', '**/*.ts')).toBe(true)
    expect(matchesGlob('.env', '.env*')).toBe(true)
    expect(matchesGlob('nested/.env.local', '.env*')).toBe(true)
    expect(matchesGlob('mt.json', 'pipelines/**')).toBe(false)
  })

  it('collects pipelines, transitive imports and relative inputs only', async () => {
    const files = await collectSyncScope(dir)
    expect(files).toEqual([
      'input/ch1.jsonl',
      'lib/helper.ts',
      'lib/nested.ts',
      'mt.json',
      'pipelines/main.ts',
    ])
  })

  it('honours a custom include but still rejects secrets', async () => {
    const files = await collectSyncScope(dir, { include: ['lib/**'] })
    expect(files).toEqual(['lib/helper.ts', 'lib/nested.ts'])
  })

  it('declares output scope from the run dir and target URIs', async () => {
    const files = await collectOutputScope(dir, { runId: 'r1' })
    expect(files).toContain('.mt/runs/r1/state.json')
    expect(files).toContain('out/ch1.md')
    expect(files.some((path) => path.includes('vault'))).toBe(false)
  })

  it('builds a sorted manifest without secrets', async () => {
    const entries = await buildManifest(dir)
    expect(entries.map((entry) => entry.path)).not.toContain('.env')
    expect(entries.map((entry) => entry.path)).not.toContain('.env.local')
    expect(entries.map((entry) => entry.path)).not.toContain('vault.json')
    expect(entries.map((entry) => entry.path)).not.toContain('secrets.kdbx')
    expect(entries.map((entry) => entry.path)).not.toContain('.mt/runs/r1/state.json')
    expect(entries.map((entry) => entry.path)).toContain('input/ch1.jsonl')
    expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true)
  })

  it('reuses hashes from the size+mtime cache', async () => {
    const cache = createSyncHashCache()
    const first = await buildManifest(dir, { hashCache: cache })
    const second = await buildManifest(dir, { hashCache: cache })
    expect(second).toEqual(first)
  })

  it('protects .env, vault and .git paths', () => {
    expect(isProtectedSyncPath('.env')).toBe(true)
    expect(isProtectedSyncPath('.env.production')).toBe(true)
    expect(isProtectedSyncPath('.mt/vault.json')).toBe(true)
    expect(isProtectedSyncPath('.git/config')).toBe(true)
    expect(isProtectedSyncPath('.mt/runs/r1/state.json')).toBe(true)
    expect(isProtectedSyncPath('.mt/runs/r1/state.json', { allowRunState: true })).toBe(false)
  })
})

describe('sync diff', () => {
  const entry = (path: string, sha256: string, size = 1) => ({
    path,
    sha256,
    size,
    mtime: 1,
  })

  it('reports added, changed, removed and unchanged by sha256', () => {
    const diff = diffManifests(
      [entry('a.ts', 'a'), entry('b.ts', 'b2'), entry('c.ts', 'c')],
      [entry('a.ts', 'a'), entry('b.ts', 'b1'), entry('d.ts', 'd')],
    )
    expect(diff.added.map((item) => item.path)).toEqual(['c.ts'])
    expect(diff.changed.map((item) => item.path)).toEqual(['b.ts'])
    expect(diff.removed).toEqual(['d.ts'])
    expect(diff.unchanged.map((item) => item.path)).toEqual(['a.ts'])
  })
})

describe('sync apply', () => {
  let dir: string
  let outside: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-sync-apply-'))
    outside = await mkdtemp(join(tmpdir(), 'mt-sync-outside-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('writes atomically and reads back', async () => {
    await writeSyncFile(dir, 'pipelines/new.ts', 'export default 1\n')
    expect(await readFile(join(dir, 'pipelines', 'new.ts'), 'utf8')).toBe('export default 1\n')
    expect((await readSyncFile(dir, 'pipelines/new.ts')).toString()).toBe('export default 1\n')
  })

  it('rejects traversal, absolute paths and protected paths', async () => {
    await expect(writeSyncFile(dir, '../escape.ts', 'x')).rejects.toThrow()
    await expect(writeSyncFile(dir, '/tmp/escape.ts', 'x')).rejects.toThrow()
    await expect(writeSyncFile(dir, '.env', 'x')).rejects.toBeInstanceOf(SyncProtectedPathError)
    await expect(writeSyncFile(dir, '.mt/vault.json', 'x')).rejects.toBeInstanceOf(
      SyncProtectedPathError,
    )
  })

  it('rejects symlinked parents and file targets', async () => {
    await symlink(outside, join(dir, 'link'))
    await expect(writeSyncFile(dir, 'link/escape.ts', 'x')).rejects.toBeInstanceOf(SyncSymlinkError)

    await writeFile(join(outside, 'real.ts'), 'x')
    await symlink(join(outside, 'real.ts'), join(dir, 'file-link.ts'))
    await expect(writeSyncFile(dir, 'file-link.ts', 'x')).rejects.toBeInstanceOf(SyncSymlinkError)
  })

  it('enforces the per-file cap', async () => {
    await expect(writeSyncFile(dir, 'big.txt', '1234', { maxBytes: 3 })).rejects.toBeInstanceOf(
      SyncFileTooLargeError,
    )
  })

  it('deletes and prunes only regular files', async () => {
    await writeSyncFile(dir, 'keep.txt', 'keep')
    await writeSyncFile(dir, 'drop.txt', 'drop')
    expect(await deleteSyncFile(dir, 'missing.txt')).toBe(false)
    expect(await deleteSyncFile(dir, 'drop.txt')).toBe(true)
    await writeSyncFile(dir, 'again.txt', 'again')
    expect(await pruneSyncFiles(dir, ['keep.txt'])).toEqual(['again.txt'])
  })

  it('allows run-state writes only when requested', async () => {
    await expect(writeSyncFile(dir, '.mt/runs/r1/state.json', '{}')).rejects.toBeInstanceOf(
      SyncProtectedPathError,
    )
    await writeSyncFile(dir, '.mt/runs/r1/state.json', '{}', { allowRunState: true })
    expect(await readSyncFile(dir, '.mt/runs/r1/state.json', { allowRunState: true })).toBeTruthy()
  })
})

describe('remote config validation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-sync-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts a remote sync section', async () => {
    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({
        project: { name: 'x' },
        remote: {
          url: 'http://localhost:7777',
          tokenRef: 'env:MT_SERVE_TOKEN',
          projectId: 'my-project',
          sync: { include: ['pipelines/**'], exclude: ['tmp/**'], maxFileBytes: 1024 },
        },
      }),
    )
    expect((await readMtConfig(dir)).remote?.sync?.maxFileBytes).toBe(1024)
  })

  it('rejects an invalid maxFileBytes and path-like projectId', async () => {
    await writeFile(join(dir, 'mt.json'), JSON.stringify({ remote: { sync: { maxFileBytes: 0 } } }))
    await expect(readMtConfig(dir)).rejects.toThrow(/maxFileBytes/)

    await writeFile(join(dir, 'mt.json'), JSON.stringify({ remote: { projectId: '../bad' } }))
    await expect(readMtConfig(dir)).rejects.toThrow(/projectId/)
  })
})
