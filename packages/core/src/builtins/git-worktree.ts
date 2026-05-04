import { basename, join } from 'node:path'
import type { SourceContext, TargetContext } from '../contexts.js'
import {
  createWorktree,
  getRepoRoot,
  mergeWorktreeToMain,
  removeWorktree,
} from '../engine/git-worktree.js'
import { autoCommit } from '../engine/git.js'
import type { Envelope, Lifecycle, Source, Target } from '../types.js'
import type { ParsedUri } from '../uri.js'
import { registry } from '../uri.js'

/**
 * GitWorktreeSource wraps an inner Source, delegating all operations
 * inside a Git worktree directory. The worktree must already exist
 * (created externally by the composite resolver or caller).
 */
export class GitWorktreeSource<T> implements Source<T> {
  constructor(
    private innerSource: Source<T>,
    private worktreePath: string,
  ) {}

  get uri(): string {
    return `${this.innerSource.uri}?git=worktree&path=${encodeURIComponent(this.worktreePath)}`
  }

  get lifestyle(): Lifecycle {
    return this.innerSource.lifestyle
  }

  async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
    const prev = process.cwd()
    try {
      process.chdir(this.worktreePath)
      yield* this.innerSource.start(ctx)
    } finally {
      process.chdir(prev)
    }
  }

  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
    if (!this.innerSource.resume) {
      throw new Error('Inner source does not support resume')
    }
    const prev = process.cwd()
    try {
      process.chdir(this.worktreePath)
      yield* this.innerSource.resume(ctx, cursor)
    } finally {
      process.chdir(prev)
    }
  }
}

/**
 * GitWorktreeTarget wraps an inner Target, creating a Git worktree on open(),
 * delegating writes to the inner Target inside the worktree, and on close():
 *   - closes the inner Target
 *   - if commitOnClose: auto-commits + rebase-merges to main
 *   - always removes the worktree (best-effort)
 */
export class GitWorktreeTarget<T> implements Target<T> {
  private branchName: string
  private opened = false

  constructor(
    private innerTarget: Target<T>,
    private repoRoot: string,
    worktreePath: string,
    private commitOnClose: boolean,
  ) {
    this.branchName = basename(worktreePath)
  }

  get uri(): string {
    return `${this.innerTarget.uri}?git=worktree&branch=${encodeURIComponent(this.branchName)}`
  }

  async open(ctx: TargetContext): Promise<void> {
    // Create the worktree
    await createWorktree(this.repoRoot, this.branchName, !this.commitOnClose)
    this.opened = true

    const prev = process.cwd()
    try {
      const worktreePath = join(this.repoRoot, 'worktrees', this.branchName)
      process.chdir(worktreePath)
      await this.innerTarget.open(ctx)
    } finally {
      process.chdir(prev)
    }
  }

  async write(env: Envelope<T>, ctx: TargetContext): Promise<void> {
    if (!this.opened) {
      throw new Error('Target not opened. Call open() before write().')
    }
    const prev = process.cwd()
    try {
      const worktreePath = join(this.repoRoot, 'worktrees', this.branchName)
      process.chdir(worktreePath)
      await this.innerTarget.write(env, ctx)
    } finally {
      process.chdir(prev)
    }
  }

  async close(ctx: TargetContext): Promise<void> {
    if (!this.opened) return

    const worktreePath = join(this.repoRoot, 'worktrees', this.branchName)

    // Close inner target first (inside worktree)
    const prev = process.cwd()
    try {
      process.chdir(worktreePath)
      await this.innerTarget.close(ctx)
    } finally {
      process.chdir(prev)
    }

    // Commit + merge if requested
    if (this.commitOnClose) {
      try {
        await autoCommit(worktreePath)
        await mergeWorktreeToMain(this.repoRoot, worktreePath)
      } catch (err) {
        console.warn(`[git-worktree] Commit/merge failed: ${err}`)
      }
    }

    // Always attempt cleanup
    try {
      await removeWorktree(worktreePath)
    } catch (err) {
      console.warn(`[git-worktree] Failed to remove worktree: ${err}`)
    }

    this.opened = false
  }
}

/**
 * Resolve a ParsedUri into a GitWorktreeSource when query param git=worktree is present.
 */
export function createGitWorktreeSource<T>(uri: ParsedUri): Source<T> {
  const innerScheme = uri.query._inner_scheme
  if (!innerScheme) {
    throw new Error(`git+ URI missing inner scheme: ${uri.raw}`)
  }

  const innerFactory = registry.getSourceFactory<T>(innerScheme)
  if (!innerFactory) {
    throw new Error(`No source registered for inner scheme: ${innerScheme} (from ${uri.raw})`)
  }

  const innerSource = innerFactory(uri)
  const branchName = uri.query.branch || `worktree-${Date.now()}`
  // repoRoot from query or CWD
  const repoRoot = uri.query.root || process.cwd()

  return new GitWorktreeSource(innerSource, join(repoRoot, 'worktrees', branchName))
}

/**
 * Resolve a ParsedUri into a GitWorktreeTarget when query param git=worktree is present.
 */
export function createGitWorktreeTarget<T>(uri: ParsedUri): Target<T> {
  const innerScheme = uri.query._inner_scheme
  if (!innerScheme) {
    throw new Error(`git+ URI missing inner scheme: ${uri.raw}`)
  }

  const innerFactory = registry.getTargetFactory<T>(innerScheme)
  if (!innerFactory) {
    throw new Error(`No target registered for inner scheme: ${innerScheme} (from ${uri.raw})`)
  }

  const innerTarget = innerFactory(uri) as Target<T>
  const branchName = uri.query.branch || `worktree-${Date.now()}`
  const repoRoot = uri.query.root || process.cwd()
  const commitOnClose = uri.query.commit === 'on-close'

  return new GitWorktreeTarget(
    innerTarget,
    repoRoot,
    join(repoRoot, 'worktrees', branchName),
    commitOnClose,
  )
}

// ---------------------------------------------------------------------------
// Module-level side effect: register git+ composite resolver
// ---------------------------------------------------------------------------

/**
 * Composite resolver for git+ URIs.
 * E.g., git+jsonl://data.jsonl?branch=feat&commit=on-close
 *
 * Parses the inner scheme and injects it as _inner_scheme query param
 * so that createGitWorktreeSource / createGitWorktreeTarget can use it.
 */
registry.registerComposite(
  'git+',
  (_schemes: string[], rest: string): import('../uri.js').ParsedUri => {
    // rest looks like: jsonl://data.jsonl?branch=feat&commit=on-close
    const parsed = registry.parse(rest)
    parsed.query._inner_scheme = parsed.scheme
    return parsed
  },
)
