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
