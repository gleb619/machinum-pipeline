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
        exitCode: typeof code === 'number' ? code : 0,
      })
    })
  })
}

/**
 * Auto-commit all changes in the repository.
 * @param cwd - The working directory for the git command.
 * @param message - Optional commit message. Defaults to "mt: auto-commit after pipeline run".
 */
export async function autoCommit(cwd: string, message?: string): Promise<void> {
  const commitMessage = message ?? 'mt: auto-commit after pipeline run'

  // Check if git is available
  const gitCheck = await execGit(cwd, ['--version'])
  if (gitCheck.exitCode !== 0) {
    console.warn('[git] git not found, skipping auto-commit')
    return
  }

  // Stage all changes
  const addResult = await execGit(cwd, ['add', '-A'])
  if (addResult.exitCode !== 0) {
    console.warn('[git] git add -A failed:', addResult.stderr)
    return
  }

  // Check if there are changes to commit
  const statusResult = await execGit(cwd, ['status', '--porcelain'])
  if (statusResult.stdout.trim() === '') {
    console.log('[git] nothing to commit')
    return
  }

  // Commit the changes
  const commitResult = await execGit(cwd, ['commit', '-m', commitMessage])
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
