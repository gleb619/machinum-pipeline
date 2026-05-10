import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import matter from 'gray-matter'

/**
 * Check 1: At least one H1 heading (line starting with "# ").
 */
function checkH1(text: string): string | null {
  if (!/^# /m.test(text)) {
    return 'Missing H1 heading — chapter must start with a level-1 heading (# Title)'
  }
  return null
}

/**
 * Check 2: Frontmatter is valid if present.
 * gray-matter throws on malformed YAML in strict mode; we catch and report.
 */
function checkFrontmatter(text: string): string | null {
  // Only validate if frontmatter delimiters are present
  if (!text.startsWith('---')) return null
  try {
    // gray-matter is lenient by default but can throw on unclosed delimiters
    const parsed = matter(text)
    // If data is empty but delimiters existed, that's fine (empty frontmatter)
    void parsed
    return null
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Invalid frontmatter: ${msg}`
  }
}

/**
 * Check 3: No heading level skips.
 * Each heading can increase depth by at most 1 level.
 */
function checkHeadingSkips(text: string): string[] {
  const errors: string[] = []
  const lines = text.split('\n')
  let inCodeBlock = false
  let prevLevel = 0

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const match = line.match(/^(#{1,6})\s/)
    if (!match) continue

    const level = (match[1] as string).length

    if (prevLevel > 0 && level > prevLevel && level > prevLevel + 1) {
      errors.push(
        `Heading level skip: H${prevLevel} → H${level} on line "${line.trim()}" — levels must be sequential`,
      )
    }
    prevLevel = level
  }

  return errors
}

/**
 * Check 4: Fenced code blocks should have a language tag.
 */
function checkCodeBlockLanguages(text: string): string[] {
  const errors: string[] = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const match = line.match(/^```(\s*)$/)
    // Match opening fence with NO language (just backticks + optional trailing whitespace)
    if (match) {
      // This could be a closing fence. Check if we're inside a block.
      // We'll track open/close properly.
      continue
    }
    // Match opening fence: ```lang  (non-empty language)
    const langMatch = line.match(/^```(\S+)/)
    if (langMatch) continue // has language, good

    // Line starts with ``` but no non-whitespace language
    const bareFence = line.match(/^```(\s*)$/)
    if (bareFence) {
      // This could be opening OR closing. We'll do a proper block-tracking pass.
    }
  }

  // Better approach: parse blocks tracking state
  let inBlock = false
  let blockStartLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fenceMatch = line.match(/^```(\S*)/)

    if (fenceMatch) {
      if (!inBlock) {
        // Opening fence
        inBlock = true
        blockStartLine = i + 1 // 1-indexed
        const lang = (fenceMatch[1] as string).trim()
        if (!lang) {
          errors.push(`Code block at line ${blockStartLine} is missing a language tag`)
        }
      } else {
        // Closing fence
        inBlock = false
      }
    }
  }

  if (inBlock) {
    errors.push(`Unclosed code block starting at line ${blockStartLine}`)
  }

  return errors
}

/**
 * Check 5: No broken markdown link references.
 * - [text][]  (empty reference — always broken)
 * - [text][ref] where [ref] is never defined with [ref]: url
 */
function checkBrokenLinks(text: string): string[] {
  const errors: string[] = []

  // Find [text][] patterns — empty reference
  const emptyRefPattern = /\[([^\]]+)\]\[\]/g
  let match = emptyRefPattern.exec(text)
  while (match !== null) {
    errors.push(`Broken link reference: "[${match[1]}]" has an empty target`)
    match = emptyRefPattern.exec(text)
  }

  // Find [text][ref] patterns and compare against [ref]: definitions
  const refLinkPattern = /\[([^\]]+)\]\[([^\]]+)\]/g
  const refLinks: Array<{ text: string; ref: string }> = []
  while ((match = refLinkPattern.exec(text)) !== null) {
    const ref = match[2] as string
    // Skip if it looks like an inline link [text](url) — those start with [
    // but our pattern catches [text][ref]. However, [text][] was already caught.
    // Also skip [text][!ref] or weird patterns
    if (ref && !ref.startsWith('!')) {
      refLinks.push({ text: match[1] as string, ref })
    }
  }

  // Find all [ref]: url definitions
  const defPattern = /^\[([^\]]+)\]:\s*\S/gm
  const definedRefs = new Set<string>()
  while ((match = defPattern.exec(text)) !== null) {
    definedRefs.add((match[1] as string).toLowerCase())
  }

  for (const link of refLinks) {
    if (!definedRefs.has(link.ref.toLowerCase())) {
      errors.push(
        `Broken link reference: "[${link.text}][${link.ref}]" — reference "[${link.ref}]" is not defined`,
      )
    }
  }

  return errors
}

export const chapterValidator = defineTool<string, string>({
  name: 'chapter-validator',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const text = env.item
    const errors: string[] = []

    // Check 1: H1 present
    const h1Error = checkH1(text)
    if (h1Error) errors.push(h1Error)

    // Check 2: Frontmatter validity
    const fmError = checkFrontmatter(text)
    if (fmError) errors.push(fmError)

    // Check 3: Heading level skips
    errors.push(...checkHeadingSkips(text))

    // Check 4: Code block language tags
    errors.push(...checkCodeBlockLanguages(text))

    // Check 5: Broken link references
    errors.push(...checkBrokenLinks(text))

    return {
      item: env.item,
      meta: {
        ...env.meta,
        valid: errors.length === 0,
        errors,
      },
    }
  },
})
