import { category, defineTool, execGit, tool, withMeta } from '@mt/core'
import type { Exchange, ExchangeMeta, Tool, ToolContext } from '@mt/core'

/** Options for {@link createGitStage} / the default `gitStage` tool. */
export interface GitStageOptions {
  /** Pathspecs to stage (`git add -- <pathspecs>`). Falls back to `meta.gitPaths`, then `git add -A`. */
  pathspecs?: string[]
  /** Working directory of the git command; defaults to `ctx.run.global.project.root`, then `process.cwd()`. */
  repoRoot?: string
}

/** Options for {@link createGitReset} / the default `gitReset` tool. */
export interface GitResetOptions {
  /** Reset mode: `soft` keeps index+worktree, `mixed` keeps worktree, `hard` discards worktree changes. */
  mode?: 'soft' | 'mixed' | 'hard'
  /** Ref to reset to; defaults to `HEAD`. */
  ref?: string
  /** Pathspecs limiting what is reset (`git reset <mode> <ref> -- <pathspecs>`). */
  pathspecs?: string[]
  /** Working directory of the git command; defaults to `ctx.run.global.project.root`, then `process.cwd()`. */
  repoRoot?: string
}

/** Options for {@link createGitCommit} / the default `gitCommit` tool. */
export interface GitCommitOptions {
  /** Commit message; falls back to `meta.commitMessage`/`meta.message`, then a generated message. */
  message?: string
  /** Stage before committing (pathspec-scoped like gitStage); defaults to true. */
  stage?: boolean
  /** Pathspecs limiting what is staged. Falls back to `meta.gitPaths`, then `git add -A`. */
  pathspecs?: string[]
  /** Working directory of the git command; defaults to `ctx.run.global.project.root`, then `process.cwd()`. */
  repoRoot?: string
}

function resolveRepoRoot(ctx: ToolContext, options?: { repoRoot?: string }): string {
  return options?.repoRoot ?? ctx.run.global.project.root ?? process.cwd()
}

async function assertGitRepo(repoRoot: string): Promise<void> {
  const res = await execGit(repoRoot, ['rev-parse', '--show-toplevel'])
  if (res.exitCode !== 0) {
    throw new Error(`not a git repository: ${repoRoot} (${res.stderr.trim() || `exit ${res.exitCode}`})`)
  }
}

/** Pathspecs from `meta.gitPaths` (string or string[]); undefined when absent. */
function pathspecsFromMeta(meta: ExchangeMeta): string[] | undefined {
  const value = meta.gitPaths
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string')
  return undefined
}

function gitFailure(action: string, stderr: string): Error {
  return new Error(`git ${action} failed: ${stderr.trim() || 'unknown error'}`)
}

/**
 * Creates a `git-stage` tool (TL258). Stages changes in a git repository via `git add`.
 *
 * Pathspecs come from options, falling back to the envelope `meta.gitPaths` (string or
 * string[]), falling back to `git add -A` in the resolved repo root. On success sets
 * `gitStaged` in the envelope meta to the number of staged files. Throws with the git
 * stderr on failure. Items pass through unchanged.
 */
export function createGitStage(options: GitStageOptions = {}): Tool<string, string> {
  return defineTool<string, string>({
    name: 'git-stage',
    version: '1.0.0',
    mdDescription:
      'Stages changes in a git repository (`git add`). Pathspecs from options, then `meta.gitPaths`, then `git add -A`. Sets `gitStaged` in envelope meta.',
    annotations: [
      tool('TL258', {
        name: 'git-stage',
        description: 'Stages repository changes, scoped by pathspecs when given.',
        refs: [],
      }),
      category(['git']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const repoRoot = resolveRepoRoot(ctx, options)
      await assertGitRepo(repoRoot)
      const pathspecs = options.pathspecs ?? pathspecsFromMeta(env.meta)
      ctx.run.logger.info(`[git-stage] staging ${pathspecs ? pathspecs.join(' ') : '-A'} in ${repoRoot}`)
      const add = pathspecs
        ? await execGit(repoRoot, ['add', '--', ...pathspecs])
        : await execGit(repoRoot, ['add', '-A'])
      if (add.exitCode !== 0) throw gitFailure('add', add.stderr)
      const staged = await execGit(repoRoot, ['diff', '--cached', '--name-only'])
      const count = staged.exitCode === 0 ? staged.stdout.split('\n').filter(Boolean).length : 0
      return withMeta(env, { gitStaged: count })
    },
  })
}

/**
 * Creates a `git-reset` tool (TL259). Runs `git reset` with a configurable mode and ref.
 *
 * Never resets outside a git repository: the repo root resolves from options to
 * `ctx.run.global.project.root` to `process.cwd()`, and the call throws when it is not
 * inside a git repo. Sets `gitReset` (the mode) in the envelope meta on success.
 * Items pass through unchanged.
 */
export function createGitReset(options: GitResetOptions = {}): Tool<string, string> {
  const mode = options.mode ?? 'mixed'
  const ref = options.ref ?? 'HEAD'
  return defineTool<string, string>({
    name: 'git-reset',
    version: '1.0.0',
    mdDescription:
      'Runs `git reset` (default `--mixed HEAD`). Resolves the repo root from options, project root, or cwd; throws outside a git repo. Sets `gitReset` in envelope meta.',
    annotations: [
      tool('TL259', {
        name: 'git-reset',
        description: 'Resets the repository (soft/mixed/hard) to a ref, optionally pathspec-scoped.',
        refs: [],
      }),
      category(['git']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const repoRoot = resolveRepoRoot(ctx, options)
      await assertGitRepo(repoRoot)
      const args = ['reset', `--${mode}`, ref]
      if (options.pathspecs && options.pathspecs.length > 0) args.push('--', ...options.pathspecs)
      ctx.run.logger.info(`[git-reset] git ${args.join(' ')} in ${repoRoot}`)
      const res = await execGit(repoRoot, args)
      if (res.exitCode !== 0) throw gitFailure('reset', res.stderr)
      return withMeta(env, { gitReset: mode })
    },
  })
}

/**
 * Creates a `git-commit` tool (TL260). Stages (unless `stage: false`) and commits.
 *
 * Message resolution: options.message → `meta.commitMessage`/`meta.message` → generated
 * `mt(<pipelineId>): <n> envelopes`. After a successful commit sets `commit` (short hash)
 * and `commitMessage` in the envelope meta; when there is nothing to commit sets
 * `commit: null` (no-op, not an error). Throws with the git stderr on failure.
 * Items pass through unchanged.
 */
export function createGitCommit(options: GitCommitOptions = {}): Tool<string, string> {
  let envelopeCount = 0
  return defineTool<string, string>({
    name: 'git-commit',
    version: '1.0.0',
    mdDescription:
      'Stages (pathspec-scoped) and commits. Message from options, `meta.commitMessage`, or generated `mt(<pipelineId>): <n> envelopes`. Sets `commit` (short hash) and `commitMessage` in envelope meta; `commit: null` when nothing to commit.',
    annotations: [
      tool('TL260', {
        name: 'git-commit',
        description: 'Stages and commits repository changes with a resolved commit message.',
        refs: [],
      }),
      category(['git']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      envelopeCount += 1
      const repoRoot = resolveRepoRoot(ctx, options)
      await assertGitRepo(repoRoot)
      const pathspecs = options.pathspecs ?? pathspecsFromMeta(env.meta)

      if (options.stage !== false) {
        const add = pathspecs
          ? await execGit(repoRoot, ['add', '--', ...pathspecs])
          : await execGit(repoRoot, ['add', '-A'])
        if (add.exitCode !== 0) throw gitFailure('add', add.stderr)
      }

      const statusArgs = pathspecs ? ['status', '--porcelain', '--', ...pathspecs] : ['status', '--porcelain']
      const status = await execGit(repoRoot, statusArgs)
      if (status.exitCode !== 0) throw gitFailure('status', status.stderr)
      if (status.stdout.trim() === '') {
        ctx.run.logger.info('[git-commit] nothing to commit')
        return withMeta(env, { commit: null })
      }

      const metaMessage = env.meta.commitMessage ?? env.meta.message
      const message =
        options.message ??
        (typeof metaMessage === 'string' ? metaMessage : undefined) ??
        `mt(${ctx.run.pipelineId ?? 'pipeline'}): ${envelopeCount} envelopes`
      ctx.run.logger.info(`[git-commit] committing in ${repoRoot}: ${message}`)
      const commitArgs = ['commit', '-m', message]
      if (pathspecs && options.stage === false) commitArgs.push('--', ...pathspecs)
      const commit = await execGit(repoRoot, commitArgs)
      if (commit.exitCode !== 0) throw gitFailure('commit', commit.stderr)

      const rev = await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'])
      const hash = rev.exitCode === 0 ? rev.stdout.trim() : null
      return withMeta(env, { commit: hash, commitMessage: message })
    },
  })
}

/** Default `git-stage` tool: stages everything (`git add -A`) in the resolved repo root. */
export const gitStage = createGitStage()

/** Default `git-reset` tool: `git reset --mixed HEAD` in the resolved repo root. */
export const gitReset = createGitReset()

/** Default `git-commit` tool: stages and commits with a resolved or generated message. */
export const gitCommit = createGitCommit()
