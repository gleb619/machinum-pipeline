import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exchange, ToolContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitCommit, createGitReset, createGitStage } from './git-tools.js'

let dir: string

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' }).trimEnd()
}

function makeCtx(): ToolContext {
  return {
    run: {
      runId: 'test-run',
      pipelineId: 'test-pipeline',
      startedAt: new Date().toISOString(),
      global: {
        project: { name: 'test', root: dir },
        defaults: {
          retry: { max: 3, backoffMs: 100, strategy: 'fixed' },
          onError: 'fail-run',
          concurrency: 1,
        },
        settings: {},
        env: {},
      },
      checkpoint: { stepId: 's1', depth: 0, path: [] },
      artifactsDir: join(dir, 'artifacts'),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
    step: { stepId: 's1', name: 'git', type: 'tool', index: 0 },
  }
}

function env(meta: Record<string, unknown> = {}): Exchange<string> {
  return { id: 'e1', item: 'payload', meta, variables: [] }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-git-tools-'))
  git('init')
  git('config user.email "test@test.com"')
  git('config user.name "Test User"')
  git('config commit.gpgsign false')
  writeFileSync(join(dir, 'initial.txt'), 'initial')
  git('add initial.txt')
  git('commit -m "initial"')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('gitStage', () => {
  it('stages with explicit pathspecs only', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    const out = await createGitStage({ pathspecs: ['a.txt'] }).invoke(env(), makeCtx())
    expect(out.meta.gitStaged).toBe(1)
    expect(git('status --porcelain')).toContain('?? b.txt')
  })

  it('falls back to meta.gitPaths (string and string[])', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    const one = await createGitStage().invoke(env({ gitPaths: 'a.txt' }), makeCtx())
    expect(one.meta.gitStaged).toBe(1)
    git('commit -m "a"')
    writeFileSync(join(dir, 'c.txt'), 'c')
    const two = await createGitStage().invoke(env({ gitPaths: ['b.txt', 'c.txt'] }), makeCtx())
    expect(two.meta.gitStaged).toBe(2)
  })

  it('stages everything with git add -A when no pathspecs given', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    const out = await createGitStage().invoke(env(), makeCtx())
    expect(out.meta.gitStaged).toBe(1)
  })
})

describe('gitReset', () => {
  it('mixed reset restores the staged state to the worktree', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    git('add a.txt')
    const out = await createGitReset().invoke(env(), makeCtx())
    expect(out.meta.gitReset).toBe('mixed')
    expect(git('status --porcelain')).toBe('?? a.txt')
    expect(git('log -1 --format=%s')).toBe('initial')
  })

  it('throws outside a git repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mt-git-outside-'))
    try {
      const ctx = makeCtx()
      ctx.run.global.project.root = outside
      await expect(createGitReset().invoke(env(), ctx)).rejects.toThrow(/not a git repository/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('gitCommit', () => {
  it('commits with an explicit message', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    const out = await createGitCommit({ message: 'explicit msg' }).invoke(env(), makeCtx())
    expect(git('log -1 --format=%s')).toBe('explicit msg')
    expect(out.meta.commitMessage).toBe('explicit msg')
    expect(out.meta.commit).toBe(git('rev-parse --short HEAD').trim())
  })

  it('commits with meta.commitMessage', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    await createGitCommit().invoke(env({ commitMessage: 'meta msg' }), makeCtx())
    expect(git('log -1 --format=%s')).toBe('meta msg')
  })

  it('generates a default message mt(<pipelineId>): <n> envelopes', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    await createGitCommit().invoke(env(), makeCtx())
    expect(git('log -1 --format=%s')).toBe('mt(test-pipeline): 1 envelopes')
  })

  it('is a no-op (commit: null) when there is nothing to commit', async () => {
    const out = await createGitCommit().invoke(env(), makeCtx())
    expect(out.meta.commit).toBeNull()
    expect(git('log -1 --format=%s')).toBe('initial')
  })

  it('scopes staging and commit to pathspecs', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    await createGitCommit({ message: 'scoped', pathspecs: ['a.txt'] }).invoke(env(), makeCtx())
    expect(git('log -1 --format=%s')).toBe('scoped')
    expect(git('show --name-only --format= HEAD')).toContain('a.txt')
    expect(git('status --porcelain')).toContain('?? b.txt')
  })
})
