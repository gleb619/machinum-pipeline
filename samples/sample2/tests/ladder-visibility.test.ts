import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(SAMPLE_DIR, '..', '..')
const LADDER_CHAPTERS_REL = 'samples/sample2/chapters/ladder-chapters'
const PLACEHOLDER_REL = `${LADDER_CHAPTERS_REL}/.gitkeep`
const PLACEHOLDER = join(SAMPLE_DIR, 'chapters', 'ladder-chapters', '.gitkeep')

/** `git check-ignore --quiet` exits 0 when the path is ignored, 1 when it stays visible. */
function git(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout.trim() }
}

const isGitCheckout = existsSync(join(REPO_ROOT, '.git'))
const placeholderTracked = git(['ls-files', '--', PLACEHOLDER_REL]).stdout.length > 0

describe('ladder output discoverability', () => {
  it('ships the ladder-chapters placeholder directory', () => {
    expect(existsSync(PLACEHOLDER)).toBe(true)
  })

  it.skipIf(!isGitCheckout)('keeps the placeholder visible to git-aware tooling', () => {
    expect(git(['check-ignore', '--quiet', PLACEHOLDER_REL]).status).toBe(1)
  })

  it.skipIf(!isGitCheckout)('still ignores the generated ladder chapters', () => {
    expect(git(['check-ignore', '--quiet', `${LADDER_CHAPTERS_REL}/chapter1.md`]).status).toBe(0)
  })

  it.skipIf(!isGitCheckout || !placeholderTracked)(
    'tracks the placeholder so fresh worktrees have the directory',
    () => {
      expect(git(['ls-files', '--', PLACEHOLDER_REL]).stdout).toBe(PLACEHOLDER_REL)
    },
  )
})
