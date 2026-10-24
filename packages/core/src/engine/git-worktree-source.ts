import { basename, isAbsolute, join } from 'node:path'
import type { SourceContext, TargetContext } from '../contexts.js'
import type { Envelope, Lifecycle, Source, Target } from '../types.js'
import type { ParsedUri } from '../uri.js'
import { registry } from '../uri.js'
import { createWorktree, mergeWorktreeToMain, removeWorktree } from './git-worktree.js'
import { autoCommit } from './git.js'

/**
 * Resolve a relative inner URI path against a Git worktree directory.
 * Absolute paths are returned unchanged.
 */
function resolveUriPathToWorktree(uri: ParsedUri, worktreePath: string): ParsedUri {
  if (!uri.path || isAbsolute(uri.path)) return uri
  return { ...uri, path: join(worktreePath, uri.path) }
}

/**
 * GitWorktreeSource wraps an inner Source, delegating all operations
 * inside a Git worktree directory. The worktree must already exist
 * (created externally by the composite resolver or caller).
 *
 * The inner Source receives a URI whose relative path has been resolved onto
 * the worktree directory. The global process working directory is never
 * changed.
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
    yield* this.innerSource.start(ctx)
  }

  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
    if (!this.innerSource.resume) {
      throw new Error('Inner source does not support resume')
    }
    yield* this.innerSource.resume(ctx, cursor)
  }
}

/**
 * GitWorktreeTarget wraps an inner Target, creating a Git worktree on open(),
 * delegating writes to the inner Target inside the worktree, and on close():
 *   - closes the inner Target
 *   - if commitOnClose: auto-commits + rebase-merges to main
 *   - always removes the worktree (best-effort)
 *
 * The inner Target receives a URI whose relative path has been resolved onto
 * the worktree directory. The global process working directory is never
 * changed, so concurrent writes cannot race on cwd.
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
    await createWorktree(this.repoRoot, this.branchName, !this.commitOnClose)
    this.opened = true
    await this.innerTarget.open(ctx)
  }

  async write(env: Envelope<T>, ctx: TargetContext): Promise<void> {
    if (!this.opened) {
      throw new Error('Target not opened. Call open() before write().')
    }
    await this.innerTarget.write(env, ctx)
  }

  async close(ctx: TargetContext): Promise<void> {
    if (!this.opened) return

    const worktreePath = join(this.repoRoot, 'worktrees', this.branchName)

    await this.innerTarget.close(ctx)

    if (this.commitOnClose) {
      try {
        await autoCommit(worktreePath)
        await mergeWorktreeToMain(this.repoRoot, worktreePath)
      } catch (err) {
        console.warn(`[git-worktree] Commit/merge failed: ${err}`)
      }
    }

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

  const branchName = uri.query.branch || `worktree-${Date.now()}`
  const repoRoot = uri.query.root || process.cwd()
  const worktreePath = join(repoRoot, 'worktrees', branchName)

  const resolvedUri = resolveUriPathToWorktree(uri, worktreePath)
  const innerSource = innerFactory(resolvedUri)

  return new GitWorktreeSource(innerSource, worktreePath)
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

  const branchName = uri.query.branch || `worktree-${Date.now()}`
  const repoRoot = uri.query.root || process.cwd()
  const worktreePath = join(repoRoot, 'worktrees', branchName)
  const commitOnClose = uri.query.commit === 'on-close'

  const resolvedUri = resolveUriPathToWorktree(uri, worktreePath)
  const innerTarget = innerFactory(resolvedUri) as Target<T>

  return new GitWorktreeTarget(innerTarget, repoRoot, worktreePath, commitOnClose)
}
