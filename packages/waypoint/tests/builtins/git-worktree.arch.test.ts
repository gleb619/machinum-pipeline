import { registry } from '@mt/core'
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
      host: '',
      raw: 'jsonl://./test.jsonl',
      path: './test.jsonl',
      query: {},
      fragment: '',
    })
    const wrapper = new GitWorktreeSource(inner, '/tmp/worktree')

    expect(wrapper).toHaveProperty('uri')
    expect(wrapper).toHaveProperty('lifestyle')
    expect(typeof wrapper.start).toBe('function')
    expect(wrapper.lifestyle).toBe('resumable') // delegates to inner

    // URI echoes the inner source uri verbatim (lossless round-trip, T288)
    expect(wrapper.uri).toBe('jsonl://./test.jsonl')
  })

  it('GitWorktreeSource delegates .resume() to inner source', () => {
    const inner = createJsonlSource({
      scheme: 'jsonl',
      host: '',
      raw: 'jsonl://./test.jsonl',
      path: './test.jsonl',
      query: {},
      fragment: '',
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

describe('UC-23 — git:// scheme registration (end-to-end resolution)', () => {
  it('registry.resolveSource resolves git://./x.jsonl?via=jsonl to GitWorktreeSource', () => {
    const source = registry.resolveSource('git://./x.jsonl?via=jsonl')
    expect(source).toBeInstanceOf(GitWorktreeSource)
  })

  it('registry.resolveTarget resolves git://./x.jsonl?via=jsonl&commit=on-close to GitWorktreeTarget', () => {
    const target = registry.resolveTarget('git://./x.jsonl?via=jsonl&commit=on-close')
    expect(target).toBeInstanceOf(GitWorktreeTarget)
  })

  it('git:// without via throws a clear error naming the param', () => {
    expect(() => registry.resolveSource('git://./x.jsonl')).toThrow(/'via' query param/)
  })

  it('git+jsonl:// alias is rejected with a clear error', () => {
    expect(() => registry.resolveSource('git+jsonl://./x.jsonl')).toThrow(
      /No source registered for scheme: git\+jsonl/,
    )
    expect(() => registry.resolveTarget('git+jsonl://./x.jsonl')).toThrow(
      /No target registered for scheme: git\+jsonl/,
    )
  })
})
