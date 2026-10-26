import { describe, expect, it } from 'vitest'
import {
  createWorktree,
  getRepoRoot,
  mergeWorktreeToMain,
  removeWorktree,
} from '../../src/engine/git-worktree.js'

describe('UC-24 — Git Worktree Engine API (architectural)', () => {
  it('createWorktree is exported as a function', () => {
    expect(typeof createWorktree).toBe('function')
  })
  it('createWorktree has 3 parameters (repoRoot, branchName, detach)', () => {
    // Function.length only counts params before the first with a default
    // detach has default=true, so it counts as 2 pre-default params
    expect(createWorktree.length).toBe(2)
  })
  it('removeWorktree is exported as a function', () => {
    expect(typeof removeWorktree).toBe('function')
  })
  it('removeWorktree has 1 parameter', () => {
    expect(removeWorktree.length).toBe(1)
  })
  it('getRepoRoot is exported as a function', () => {
    expect(typeof getRepoRoot).toBe('function')
  })
  it('getRepoRoot has 1 parameter', () => {
    expect(getRepoRoot.length).toBe(1)
  })
  it('mergeWorktreeToMain is exported as a function', () => {
    expect(typeof mergeWorktreeToMain).toBe('function')
  })
  it('mergeWorktreeToMain has 2 parameters (repoRoot, worktreePath, options?)', () => {
    // options has a default value, so function.length counts only the params before it
    expect(mergeWorktreeToMain.length).toBe(2)
  })
  it('mergeWorktreeToMain returns a Promise', () => {
    const p = mergeWorktreeToMain('/nonexistent', '/nonexistent')
    expect(p).toHaveProperty('then')
    p.catch(() => {})
  })
  it('all exports return Promises', async () => {
    // createWorktree and getRepoRoot return Promise<string> when called with valid args
    // Just check that calling them returns an object with .then
    const p1 = createWorktree('/nonexistent', 'test')
    expect(p1).toHaveProperty('then')
    const p2 = getRepoRoot('/tmp')
    expect(p2).toHaveProperty('then')
    // Clean up rejected promises silently
    p1.catch(() => {})
    p2.catch(() => {})
  })
})
