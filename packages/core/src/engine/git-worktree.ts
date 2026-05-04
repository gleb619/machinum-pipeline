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
 * Merge a worktree branch into main using rebase + fast-forward, then delete it.
 *
 * Steps performed (all git operations executed in `repoRoot`):
 * 1. Determine the branch name from the worktree (`rev-parse --abbrev-ref HEAD`).
 * 2. Checkout `main`.
 * 3. Rebase main onto the worktree branch (`git rebase <branch>`).
 * 4. Fast-forward merge the branch into main (`git merge --ff-only <branch>`).
 * 5. Delete the merged branch (`git branch -d <branch>`).
 *
 * @param repoRoot - Root of the git repository.
 * @param worktreePath - Path to the worktree whose branch will be merged.
 * @param _commitMessage - Reserved for future use (not currently applied during merge).
 */
export async function mergeWorktreeToMain(
  repoRoot: string,
  worktreePath: string,
  _commitMessage?: string,
): Promise<void> {
  // Determine branch name from the worktree
  const branchResult = await execGit(repoRoot, [
    '-C',
    worktreePath,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ])
  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to determine branch name: ${branchResult.stderr}`)
  }

  const branchName = branchResult.stdout.trim()
  if (branchName === 'HEAD') {
    throw new Error('Worktree is in detached HEAD state; cannot determine branch name for merge')
  }

  // Detach the worktree so the branch is no longer "checked out" and can be deleted later
  await execGit(repoRoot, ['-C', worktreePath, 'checkout', '--detach'])

  // Checkout main
  let result = await execGit(repoRoot, ['checkout', 'main'])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to checkout main: ${result.stderr}`)
  }

  // Rebase main onto the worktree branch
  result = await execGit(repoRoot, ['rebase', branchName])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to rebase: ${result.stderr}`)
  }

  // Fast-forward merge the branch into main
  result = await execGit(repoRoot, ['merge', '--ff-only', branchName])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to merge: ${result.stderr}`)
  }

  // Delete the now-merged branch
  result = await execGit(repoRoot, ['branch', '-d', branchName])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete branch: ${result.stderr}`)
  }
}
