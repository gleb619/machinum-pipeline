/**
 * Git command execution result.
 */
export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}
