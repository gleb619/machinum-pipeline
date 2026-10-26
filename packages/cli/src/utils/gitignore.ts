import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@mt/core'

/**
 * Gitignore patterns `mt init` guarantees: the whole `.mt/` state dir plus every
 * vault file name, so a secret vault can never be committed by accident.
 */
export const VAULT_IGNORE_PATTERNS = ['.mt/', 'vault.json', '*.vault.json', '.mt/vault*', '*.kdbx']

/** Accepted spellings of a pattern: the pattern itself and its slash-less form. */
function variantsFor(pattern: string): string[] {
  const variants = [pattern]
  if (pattern.endsWith('/')) variants.push(pattern.slice(0, -1))
  return variants
}

/** Strip comments and blanks; a leading `/` does not change what a pattern matches. */
function activeLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\/+/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** Patterns from `patterns` that no existing ignore line already covers. */
export function missingIgnorePatterns(content: string, patterns: string[]): string[] {
  const lines = activeLines(content)
  return patterns.filter((pattern) => !lines.some((line) => variantsFor(pattern).includes(line)))
}

/**
 * Append the missing `patterns` to `<root>/.gitignore` (creating it when absent).
 * Idempotent: a second run finds every pattern present and writes nothing.
 * Returns the appended lines.
 */
export async function ensureIgnorePatterns(root: string, patterns: string[]): Promise<string[]> {
  const path = join(root, '.gitignore')
  let content = ''
  try {
    content = await readFile(path, 'utf-8')
  } catch {
    content = ''
  }
  const missing = missingIgnorePatterns(content, patterns)
  if (missing.length === 0) return []
  const prefix = content === '' || content.endsWith('\n') ? content : `${content}\n`
  await atomicWriteFile(path, `${prefix}${missing.join('\n')}\n`)
  return missing
}
