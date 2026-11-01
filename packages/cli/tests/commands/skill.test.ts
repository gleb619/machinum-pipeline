import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillCommand } from '../../src/commands/skill.js'
import { SKILL_MD, SKILL_VERSION } from '../../src/generated/skill-content.js'

const here = dirname(fileURLToPath(import.meta.url))
const skillDoc = join(here, '..', '..', '..', '..', 'docs', 'SKILL.md')

describe('skill command', () => {
  let testDir: string
  let originalCwd: string
  let stdout: string
  let stderr: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-skill-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      stdout += `${a.join(' ')}\n`
    })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      stderr += `${a.join(' ')}\n`
    })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
    await rm(testDir, { recursive: true, force: true })
  })

  it('embedded copy matches docs/SKILL.md (drift guard)', async () => {
    const doc = await readFile(skillDoc, 'utf-8')
    expect(SKILL_MD).toBe(doc)
    expect(SKILL_VERSION).toBe(/skill-version:\s*([^\s|]+)/.exec(doc)?.[1])
  })

  it('has YAML frontmatter with name and description', () => {
    expect(SKILL_MD).toMatch(/^---\nname: mt\ndescription: .+\n---\n/)
  })

  it('prints only the skill to stdout', async () => {
    await skillCommand([])
    expect(stdout).toBe(SKILL_MD)
    expect(stderr).toBe('')
  })

  it('--out writes atomically, creates parent dirs, refuses overwrite without --force', async () => {
    await skillCommand(['--out', 'a/b/SKILL.md'])
    const file = join(testDir, 'a', 'b', 'SKILL.md')
    expect(await readFile(file, 'utf-8')).toBe(SKILL_MD)
    expect(stdout).toBe('')

    await writeFile(file, 'custom')
    await expect(skillCommand(['--out', 'a/b/SKILL.md'])).rejects.toThrow('exit:1')
    expect(stderr).toContain('already exists')
    expect(await readFile(file, 'utf-8')).toBe('custom')

    await skillCommand(['--out', 'a/b/SKILL.md', '--force'])
    expect(await readFile(file, 'utf-8')).toBe(SKILL_MD)
  })

  it('--install defaults to .agent/skills/mt/SKILL.md', async () => {
    await skillCommand(['--install'])
    expect(await readFile(join(testDir, '.agent/skills/mt/SKILL.md'), 'utf-8')).toBe(SKILL_MD)
  })

  it.each([
    ['claude', '.claude/skills/mt'],
    ['codex', '.codex/skills/mt'],
    ['opencode', '.opencode/skills/mt'],
    ['agents', '.agent/skills/mt'],
  ])('--install --target %s', async (target, dir) => {
    await skillCommand(['--install', '--target', target])
    expect(await readFile(join(testDir, dir, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD)
  })

  it('--install <dir> uses the explicit dir', async () => {
    await skillCommand(['--install', 'custom/dir'])
    expect(await readFile(join(testDir, 'custom/dir/SKILL.md'), 'utf-8')).toBe(SKILL_MD)
  })

  it('--path prints the version', async () => {
    await skillCommand(['--path'])
    expect(stdout).toContain(SKILL_VERSION)
    expect(stdout).toContain('docs/SKILL.md')
  })

  it.each([
    [['--bogus'], 'Unknown option'],
    [['--target', 'nope', '--install'], 'Unknown target'],
    [['--target', 'claude'], 'requires --install'],
    [['--out'], 'requires a file'],
    [['extra'], 'Unexpected argument'],
    [['--install', '--out', 'x'], 'not both'],
  ])('usage error %j -> stderr + exit 1', async (args, message) => {
    await expect(skillCommand(args)).rejects.toThrow('exit:1')
    expect(stderr).toContain(message)
    expect(stdout).toBe('')
  })
})
