import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * Git command execution result.
 */
export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Execute a git command in the specified working directory.
 * @param cwd - The working directory for the git command.
 * @param args - Git command arguments.
 * @returns The command result with stdout, stderr, and exit code.
 */
export async function execGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      const code = error?.code
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: typeof code === 'number' ? code : error ? 1 : 0,
      })
    })
  })
}

/**
 * Auto-commit changes in the repository.
 *
 * When `paths` is given, only those pathspecs are staged and committed
 * (`git add -- <paths>` + pathspec commit), so unrelated work-in-progress
 * and pre-staged changes stay out of the commit. Without `paths`, all
 * changes are staged (`git add -A`).
 *
 * @param cwd - The working directory for the git command.
 * @param message - Optional commit message. Defaults to "mt: auto-commit after pipeline run".
 * @param paths - Optional pathspecs limiting what is staged and committed.
 */
export async function autoCommit(cwd: string, message?: string, paths?: string[]): Promise<void> {
  const commitMessage = message ?? 'mt: auto-commit after pipeline run'
  const scoped = paths !== undefined && paths.length > 0
  const pathArgs = scoped ? ['--', ...paths] : []

  // Check if git is available
  const gitCheck = await execGit(cwd, ['--version'])
  if (gitCheck.exitCode !== 0) {
    console.warn('[git] git not found, skipping auto-commit')
    return
  }

  // Stage changes (scoped to paths when given)
  const addResult = await execGit(cwd, scoped ? ['add', ...pathArgs] : ['add', '-A'])
  if (addResult.exitCode !== 0) {
    console.warn('[git] git add failed:', addResult.stderr)
    return
  }

  // Check if there are changes to commit
  const statusResult = await execGit(cwd, ['status', '--porcelain', ...pathArgs])
  if (statusResult.stdout.trim() === '') {
    console.log('[git] nothing to commit')
    return
  }

  // Commit the changes (pathspec commit keeps pre-staged unrelated changes out)
  const commitResult = await execGit(
    cwd,
    scoped ? ['commit', '-m', commitMessage, ...pathArgs] : ['commit', '-m', commitMessage],
  )
  if (commitResult.exitCode !== 0) {
    if (commitResult.stderr.includes('nothing to commit')) {
      console.log('[git] nothing to commit')
      return
    }
    console.warn('[git] git commit failed:', commitResult.stderr)
    return
  }

  console.log('[git] auto-committed successfully')
}
