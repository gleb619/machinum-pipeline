import { exec as execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoCommit, execGit } from '../../src/engine/git.js'

describe('git', () => {
  let tempDir: string

  beforeEach(() => {
    // Create a temp directory and initialize a git repo
    tempDir = mkdtempSync('/tmp/test-git-')
    execSync('git init', { cwd: tempDir })
    execSync('git config user.email "test@test.com"', { cwd: tempDir })
    execSync('git config user.name "Test"', { cwd: tempDir })
  })

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('execGit', () => {
    it('should execute git command and return result', async () => {
      const result = await execGit(tempDir, ['status'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('No commits yet')
    })

    it('should return non-zero exit code for invalid command', async () => {
      const result = await execGit(tempDir, ['invalid-command'])
      expect(result.exitCode).not.toBe(0)
    })
  })

  describe('autoCommit', () => {
    it('should create a commit when there are changes', async () => {
      // Create a file and stage it
      writeFileSync(join(tempDir, 'test.txt'), 'hello world')

      // Run autoCommit
      await autoCommit(tempDir, 'test commit')

      // Verify commit was created
      const logResult = await execGit(tempDir, ['log', '--oneline'])
      expect(logResult.stdout).toContain('test commit')
    })

    it('should handle nothing to commit gracefully', async () => {
      // Don't create any files, just run autoCommit on clean repo
      const result = await autoCommit(tempDir)
      expect(result).toBeUndefined() // Should not throw
    })

    it('should use default message when not provided', async () => {
      // Create a file
      writeFileSync(join(tempDir, 'test.txt'), 'hello world')

      // Run autoCommit without message
      await autoCommit(tempDir)

      // Verify commit was created with default message
      const logResult = await execGit(tempDir, ['log', '--oneline'])
      expect(logResult.stdout).toContain('mt: auto-commit after pipeline run')
    })
  })
})
