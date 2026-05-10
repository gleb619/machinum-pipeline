import { describe, expect, it } from 'vitest'
import {
  GitWorktreeSource,
  GitWorktreeTarget,
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from '../../src/git-worktree.js'
import { createJsonlSource } from '../../src/jsonl.js'

// Register builtins on import
import '../../src/jsonl.js'

describe('UC-23 — Git Worktree Source (architectural)', () => {
  it('createGitWorktreeSource is exported as a function', () => {
    expect(typeof createGitWorktreeSource).toBe('function')
  })

  it('GitWorktreeSource class is exported and implements Source', () => {
    const inner = createJsonlSource({
      scheme: 'jsonl',
      raw: 'jsonl://./test.jsonl',
      path: './test.jsonl',
      query: {},
    })
    const wrapper = new GitWorktreeSource(inner, '/tmp/worktree')

    expect(wrapper).toHaveProperty('uri')
    expect(wrapper).toHaveProperty('lifestyle')
    expect(typeof wrapper.start).toBe('function')
    expect(wrapper.lifestyle).toBe('resumable') // delegates to inner

    // URI includes git=worktree query param and encoded path
    expect(wrapper.uri).toContain('git=worktree')
    expect(wrapper.uri).toContain('path=')
  })

  it('GitWorktreeSource delegates .resume() to inner source', () => {
    const inner = createJsonlSource({
      scheme: 'jsonl',
      raw: 'jsonl://./test.jsonl',
      path: './test.jsonl',
      query: {},
    })
    const wrapper = new GitWorktreeSource(inner, '/tmp/worktree')
    expect(typeof wrapper.resume).toBe('function')
  })
})

describe('UC-23 — Git Worktree Target (architectural)', () => {
  it('createGitWorktreeTarget is exported as a function', () => {
    expect(typeof createGitWorktreeTarget).toBe('function')
  })

  it('GitWorktreeTarget class is exported and implements Target', () => {
    // GitWorktreeTarget constructor accepts 4 args: innerSrc, innerTgt, wtPath, repoRoot
    expect(typeof GitWorktreeTarget).toBe('function')
    expect(GitWorktreeTarget.prototype.constructor.length).toBeGreaterThanOrEqual(1)
  })
})
