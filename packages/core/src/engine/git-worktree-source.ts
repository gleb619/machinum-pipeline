import { basename, isAbsolute, join } from 'node:path'

import { createConsoleLogger } from '../logging.js'
import type { Lifecycle, Source, Target } from '../types.js'

import type { Exchange, ExchangeInput, ParsedUri, SourceContext, TargetContext } from '../types.js'
import { registry } from '../uri.js'
import { createWorktree, mergeWorktreeToMain, removeWorktree } from './git-worktree.js'
import { autoCommit } from './git.js'

const logger = createConsoleLogger()

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
    _worktreePath: string,
  ) {}

  /**
   * The inner source's URI echoes the original `git://` URI verbatim (waypoint
   * factories keep `uri.raw`), so returning it unchanged keeps the string form
   * lossless: the DSL stores it and the Runner re-resolves it to an identical
   * wrapper. Appending a synthetic query suffix here used to corrupt the query
   * (`?…?git=worktree`) and silently drop params like `commit=on-close` (T288).
   */
  get uri(): string {
    return this.innerSource.uri
  }

  get lifestyle(): Lifecycle {
    return this.innerSource.lifestyle
  }

  async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
    yield* this.innerSource.start(ctx)
  }

  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>> {
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
 *   - if commitOnClose: auto-commits + rebases the worktree branch onto the base
 *     branch and fast-forwards it (only if the base branch is checked out and clean)
 *   - always removes the worktree (best-effort)
 *
 * The base branch is auto-detected (origin HEAD → init.defaultBranch → repoRoot's
 * current branch), overridable via the URI `base` query param. The operator's
 * checkout is never switched; a skipped merge is reported as a run warning event
 * including the unmerged branch name.
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
    private baseBranch?: string,
  ) {
    this.branchName = basename(worktreePath)
  }

  /**
   * Returns the inner target's URI verbatim — see {@link GitWorktreeSource.uri}
   * for why the wrapper must not synthesize a query suffix (T288).
   */
  get uri(): string {
    return this.innerTarget.uri
  }

  async open(ctx: TargetContext): Promise<void> {
    await createWorktree(this.repoRoot, this.branchName, !this.commitOnClose)
    this.opened = true
    await this.innerTarget.open(ctx)
  }

  async write(env: Exchange<T>, ctx: TargetContext): Promise<void> {
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
        const result = await mergeWorktreeToMain(this.repoRoot, worktreePath, {
          base: this.baseBranch,
        })
        if (!result.merged) {
          ctx.run.logger.warn(`[git-worktree] ${result.reason}`)
        }
      } catch (err) {
        ctx.run.logger.warn(`[git-worktree] Commit/merge failed: ${err}`)
      }
    }

    try {
      await removeWorktree(worktreePath)
    } catch (err) {
      logger.warn(`[git-worktree] Failed to remove worktree: ${err}`)
    }

    this.opened = false
  }
}

/**
 * Resolve a ParsedUri into a GitWorktreeSource. The inner scheme comes from
 * the `via` query param.
 */
export function createGitWorktreeSource<T>(uri: ParsedUri): Source<T> {
  const innerScheme = uri.query.via
  if (!innerScheme) {
    throw new Error(
      `git:// URI missing required 'via' query param naming the inner scheme: ${uri.raw}`,
    )
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
 * Resolve a ParsedUri into a GitWorktreeTarget. The inner scheme comes from
 * the `via` query param.
 */
export function createGitWorktreeTarget<T>(uri: ParsedUri): Target<T> {
  const innerScheme = uri.query.via
  if (!innerScheme) {
    throw new Error(
      `git:// URI missing required 'via' query param naming the inner scheme: ${uri.raw}`,
    )
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
  const base = uri.query.base

  return new GitWorktreeTarget(innerTarget, repoRoot, worktreePath, commitOnClose, base)
}
