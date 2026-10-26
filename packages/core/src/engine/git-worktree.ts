import { join } from 'node:path'
import { execGit } from './git.js'

/**
 * Create a Git worktree for the given branch name.
 *
 * Runs `git worktree add` targeting a directory under
 * `<repoRoot>/worktrees/<branchName>`. By default, it creates a detached
 * worktree. If `detach` is false, it creates a new branch with the same name.
 *
 * @param repoRoot - Root of the git repository (as returned by getRepoRoot).
 * @param branchName - Name used for the worktree directory and branch identity.
 * @param detach - Whether to create a detached HEAD (default: true).
 * @returns The absolute filesystem path to the created worktree.
 */
export async function createWorktree(
  repoRoot: string,
  branchName: string,
  detach = true,
): Promise<string> {
  const worktreePath = join(repoRoot, 'worktrees', branchName)
  const args = ['worktree', 'add']
  if (detach) {
    args.push('--detach')
  } else {
    args.push('-b', branchName)
  }
  args.push(worktreePath)

  const result = await execGit(repoRoot, args)
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`)
  }
  return worktreePath
}

/**
 * Remove a Git worktree and clean up its directory and metadata.
 *
 * Runs `git worktree remove --force` targeting the worktree path.
 * The command is executed from the worktree directory itself; Git
 * resolves the main repository via the worktree's `.git` file.
 *
 * @param worktreePath - Absolute path to the worktree to remove.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  const result = await execGit(worktreePath, ['worktree', 'remove', '--force', worktreePath])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to remove worktree: ${result.stderr}`)
  }
}

/**
 * Determine the git repository root by walking up from the given directory.
 *
 * Runs `git rev-parse --show-toplevel` and returns the trimmed stdout.
 *
 * @param cwd - Directory to start the search from.
 * @returns The absolute path to the repository root.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execGit(cwd, ['rev-parse', '--show-toplevel'])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find git repo root: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Options for mergeWorktreeToMain.
 */
export interface MergeWorktreeOptions {
  /**
   * Base branch to rebase the worktree branch onto and fast-forward.
   * Overrides auto-detection (origin HEAD → init.defaultBranch → repoRoot's current branch).
   */
  base?: string
  /** Reserved for future use (not currently applied during merge). */
  commitMessage?: string
}

/**
 * Outcome of mergeWorktreeToMain.
 */
export interface MergeWorktreeResult {
  /** Whether the worktree branch was merged into the base branch. */
  merged: boolean
  /** Name of the worktree branch. */
  branch: string
  /** Base branch the worktree branch was rebased onto. */
  base: string
  /** Why the merge was skipped (branch left unmerged in the repository). */
  reason?: string
}

/**
 * Detect the repository's default (base) branch.
 *
 * Resolution order:
 * 1. `symbolic-ref refs/remotes/origin/HEAD` (origin's default branch, `origin/` prefix stripped)
 * 2. `git config init.defaultBranch`
 * 3. The current branch of `repoRoot`
 *
 * @param repoRoot - Root of the git repository.
 * @returns The detected base branch name.
 */
async function detectBaseBranch(repoRoot: string): Promise<string> {
  const origin = await execGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (origin.exitCode === 0 && origin.stdout.trim() !== '') {
    return origin.stdout.trim().replace(/^origin\//, '')
  }

  const configured = await execGit(repoRoot, ['config', 'init.defaultBranch'])
  if (configured.exitCode === 0 && configured.stdout.trim() !== '') {
    return configured.stdout.trim()
  }

  const current = await execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.exitCode === 0 && current.stdout.trim() !== '' && current.stdout.trim() !== 'HEAD') {
    return current.stdout.trim()
  }

  throw new Error(
    'Unable to determine base branch: no origin/HEAD, no init.defaultBranch config, and repoRoot is in detached HEAD state',
  )
}

/**
 * Merge a worktree branch into the repository's base branch using rebase + fast-forward,
 * then delete it.
 *
 * Steps performed:
 * 1. Determine the branch name from the worktree (`rev-parse --abbrev-ref HEAD`).
 * 2. Detect the base branch (see {@link detectBaseBranch}), unless overridden via `options.base`.
 * 3. Rebase the worktree branch onto the base branch **inside the worktree**
 *    (`git -C <worktree> rebase <base>`) — the base branch's history is never rewritten.
 * 4. Detach the worktree so the branch can be deleted later.
 * 5. In `repoRoot`, fast-forward the base branch (`git merge --ff-only <branch>`) —
 *    only when the base branch is the checked-out branch and the tree is clean.
 *    Otherwise the branch is left unmerged and the result reports `merged: false`
 *    with the branch name; the operator's checkout is never switched.
 * 6. Delete the merged branch (`git branch -d <branch>`).
 *
 * @param repoRoot - Root of the git repository (the operator's checkout; never checked out/switched).
 * @param worktreePath - Path to the worktree whose branch will be merged.
 * @param options - Optional base branch override and reserved commit message.
 * @returns The merge outcome (merged or skipped with the unmerged branch name).
 */
export async function mergeWorktreeToMain(
  repoRoot: string,
  worktreePath: string,
  options: MergeWorktreeOptions = {},
): Promise<MergeWorktreeResult> {
  // Determine branch name from the worktree
  const branchResult = await execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to determine branch name: ${branchResult.stderr}`)
  }

  const branchName = branchResult.stdout.trim()
  if (branchName === 'HEAD') {
    throw new Error('Worktree is in detached HEAD state; cannot determine branch name for merge')
  }

  // Determine and verify the base branch
  const base = options.base ?? (await detectBaseBranch(repoRoot))
  const baseCheck = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', base])
  if (baseCheck.exitCode !== 0) {
    throw new Error(`Base branch '${base}' does not exist in the repository`)
  }

  // Rebase the worktree branch onto the base branch (inside the worktree).
  // This never rewrites the base branch's own history.
  const rebase = await execGit(worktreePath, ['rebase', base])
  if (rebase.exitCode !== 0) {
    throw new Error(`Failed to rebase '${branchName}' onto '${base}': ${rebase.stderr}`)
  }

  // Detach the worktree so the branch is no longer "checked out" and can be deleted later
  await execGit(worktreePath, ['checkout', '--detach'])

  // Fast-forward the base branch in repoRoot — only if it is the checked-out branch
  // and the tree is clean. Never switch the operator's checkout.
  const unmerged = (reason: string): MergeWorktreeResult => ({
    merged: false,
    branch: branchName,
    base,
    reason,
  })

  const current = await execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const currentBranch = current.stdout.trim()
  if (current.exitCode !== 0 || currentBranch === 'HEAD') {
    return unmerged(`base branch '${base}' was not updated (operator checkout is detached)`)
  }
  if (currentBranch !== base) {
    return unmerged(
      `unmerged: '${branchName}' — base branch '${base}' is not checked out (operator is on '${currentBranch}')`,
    )
  }

  // Cleanliness = no modified tracked files; untracked files (e.g. the
  // repoRoot/worktrees/ directory itself) must not block the fast-forward.
  const status = await execGit(repoRoot, ['status', '--porcelain', '--untracked-files=no'])
  if (status.exitCode !== 0) {
    throw new Error(`Failed to check working tree status: ${status.stderr}`)
  }
  if (status.stdout.trim() !== '') {
    return unmerged(
      `unmerged: '${branchName}' — working tree is dirty; base branch '${base}' left untouched`,
    )
  }

  // Fast-forward merge the rebased branch into the base branch
  const merge = await execGit(repoRoot, ['merge', '--ff-only', branchName])
  if (merge.exitCode !== 0) {
    throw new Error(`Failed to merge '${branchName}' into '${base}': ${merge.stderr}`)
  }

  // Delete the now-merged branch
  const del = await execGit(repoRoot, ['branch', '-d', branchName])
  if (del.exitCode !== 0) {
    throw new Error(`Failed to delete branch '${branchName}': ${del.stderr}`)
  }

  return { merged: true, branch: branchName, base }
}
