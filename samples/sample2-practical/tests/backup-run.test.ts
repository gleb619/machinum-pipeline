import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BackupMeta, backupRun } from '../scripts/backup-run.js'

const roots: string[] = []

/** A throwaway book tree: two EN chapters, no RU side yet. */
async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-backup-'))
  roots.push(root)
  await mkdir(join(root, 'chapters/en'), { recursive: true })
  await writeFile(join(root, 'chapters/en/chapter1.md'), '# One\n')
  await writeFile(join(root, 'chapters/en/chapter2.md'), '# Two\n')
  return root
}

async function readMeta(dir: string): Promise<BackupMeta> {
  return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as BackupMeta
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('backupRun', () => {
  it('copies the EN chapters and records counts plus missing inputs', async () => {
    const root = await makeTree()
    const { dir } = await backupRun({ label: 'smoke', root })
    const meta = await readMeta(dir)

    expect(meta.label).toBe('smoke')
    expect(meta.counts.en).toBe(2)
    expect(meta.counts.ru).toBe(0)
    expect(meta.missing).toContain('chapters/ru')
    expect(meta.missing).toEqual([...new Set(meta.missing)])
    expect(meta.missing.filter((rel) => rel.startsWith('chapters/book'))).toHaveLength(1)
    await expect(stat(join(dir, 'chapters/en/chapter1.md'))).resolves.toBeTruthy()
  })

  it('replaces an existing backup cleanly', async () => {
    const root = await makeTree()
    const first = await backupRun({ label: 'repeat', root })
    await writeFile(join(first.dir, 'stale.txt'), 'gone\n')
    const second = await backupRun({ label: 'repeat', root })

    expect(second.dir).toBe(first.dir)
    await expect(stat(join(second.dir, 'stale.txt'))).rejects.toThrow()
    expect((await readMeta(second.dir)).counts.en).toBe(2)
  })

  it.each(['../x', 'a/b', ''])('rejects the unsafe label %j', async (label) => {
    const root = await makeTree()
    await expect(backupRun({ label, root })).rejects.toThrow()
  })
})
