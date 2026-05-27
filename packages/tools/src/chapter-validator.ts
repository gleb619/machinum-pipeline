import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { spellCheckDocument } from 'cspell-lib'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import { type ChapterDoc, readChapterDoc } from './chapter-doc.js'

export interface ChapterDocWarning {
  id: string
  text: string
}

export interface FinderInput {
  text: string
}

export interface FinderOutput {
  text: string
  issues: ChapterDocWarning[]
}

export interface EntityNormalizerInput {
  text: string
}

export interface EntityNormalizerOutput {
  text: string
  replacements: number
}

export interface MarkdownFormatterInput {
  text: string
}

export interface MarkdownFormatterOutput {
  text: string
  fixes: number
}

// ---------------------------------------------------------------------------
// Tool 1: Forbidden Char Detector
// ---------------------------------------------------------------------------

interface ForbiddenEntry {
  char: string
  codePoint: number
  pos: number
  line: number
}

const ZERO_WIDTH_RANGES: [number, number][] = [
  [0x200b, 0x200d],
  [0xfeff, 0xfeff],
]

function isZeroWidth(codePoint: number): boolean {
  return ZERO_WIDTH_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

function isForbiddenControl(codePoint: number): boolean {
  return codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d
}

export const forbiddenCharDetector = defineTool<string, string>({
  name: 'forbidden-char-detector',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const text = env.item
    const lines = text.split('\n')
    const forbidden: ForbiddenEntry[] = []
    let globalPos = 0

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] as string
      for (let col = 0; col < line.length; col++) {
        const char = line[col] as string
        const codePoint = char.codePointAt(0)
        if (codePoint === undefined) continue

        if (isZeroWidth(codePoint) || isForbiddenControl(codePoint)) {
          forbidden.push({ char, codePoint, pos: globalPos + col, line: lineIdx + 1 })
        }
      }
      globalPos += line.length + 1
    }

    return { item: env.item, meta: { ...env.meta, forbidden } }
  },
})

// ---------------------------------------------------------------------------
// Tool 2: Chapter Validator
// ---------------------------------------------------------------------------

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
 * Check 2: No heading level skips.
 * Each heading can increase depth by at most 1 level.
 */
function checkHeadingSkips(text: string): string[] {
  const errors: string[] = []
  const lines = text.split('\n')
  let inCodeBlock = false
  let prevLevel = 0

  for (const line of lines) {
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
 * Check 3: Fenced code blocks should have a language tag.
 */
function checkCodeBlockLanguages(text: string): string[] {
  const errors: string[] = []
  const lines = text.split('\n')

  let inBlock = false
  let blockStartLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fenceMatch = line.match(/^```(\S*)/)

    if (fenceMatch) {
      if (!inBlock) {
        inBlock = true
        blockStartLine = i + 1
        const lang = (fenceMatch[1] as string).trim()
        if (!lang) {
          errors.push(`Code block at line ${blockStartLine} is missing a language tag`)
        }
      } else {
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
 * Check 4: No broken markdown link references.
 * - [text][]  (empty reference — always broken)
 * - [text][ref] where [ref] is never defined with [ref]: url
 */
function checkBrokenLinks(text: string): string[] {
  const errors: string[] = []

  const emptyRefPattern = /\[([^\]]+)\]\[\]/g
  let match = emptyRefPattern.exec(text)
  while (match !== null) {
    errors.push(`Broken link reference: "[${match[1]}]" has an empty target`)
    match = emptyRefPattern.exec(text)
  }

  const refLinkPattern = /\[([^\]]+)\]\[([^\]]+)\]/g
  const refLinks: Array<{ text: string; ref: string }> = []
  while ((match = refLinkPattern.exec(text)) !== null) {
    const ref = match[2] as string
    if (ref && !ref.startsWith('!')) {
      refLinks.push({ text: match[1] as string, ref })
    }
  }

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

    try {
      readChapterDoc(text)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
    }

    const h1Error = checkH1(text)
    if (h1Error) errors.push(h1Error)

    errors.push(...checkHeadingSkips(text))
    errors.push(...checkCodeBlockLanguages(text))
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

// ---------------------------------------------------------------------------
// Tool 3: Typo Finder
// ---------------------------------------------------------------------------

export const typoFinder = defineTool<FinderInput, FinderOutput>({
  name: 'typo-finder',
  version: '2.0.0',
  exec: 'inproc',

  async invoke(env: Envelope<FinderInput>, _ctx: ToolContext): Promise<Envelope<FinderOutput>> {
    const { text } = env.item

    const document = {
      uri: 'input.txt',
      text,
      languageId: 'plaintext',
      locale: 'en',
    }
    const options = { generateSuggestions: true }
    const settings = { suggestionsTimeout: 2000 }

    const checkResult = await spellCheckDocument(document, options, settings)

    const issues: ChapterDocWarning[] = []

    for (const issue of checkResult.issues) {
      if (
        issue.issueType === 0 /* IssueType.spelling */ &&
        issue.suggestions?.length &&
        issue.text
      ) {
        const wrong = issue.text
        const correct = issue.suggestions[0]
        if (!correct) continue
        const context = (issue as unknown as { context?: { startLine: number; startCol: number } })
          .context
        issues.push({
          id: `typo-${context?.startLine ?? 0}-${context?.startCol ?? 0}`,
          text: `Typo on line ${context?.startLine ?? '?'}: \`${wrong}\` → \`${correct}\``,
        })
      }
    }

    const existingWarnings = (env.meta?.warnings as ChapterDocWarning[] | undefined) ?? []
    const allWarnings: ChapterDocWarning[] = [...existingWarnings, ...issues]

    return {
      item: { text, issues },
      meta: {
        ...env.meta,
        typoWarned: true,
        warnings: allWarnings,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 4: Markdown Formatter
// ---------------------------------------------------------------------------

export const markdownFormatter = defineTool<MarkdownFormatterInput, MarkdownFormatterOutput>({
  name: 'markdown-formatter',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(
    env: Envelope<MarkdownFormatterInput>,
    _ctx: ToolContext,
  ): Promise<Envelope<MarkdownFormatterOutput>> {
    const { text } = env.item
    let fixes = 0

    const listMatches = text.match(/^(\s*)[*+]\s/gm)
    const listFixCount = listMatches ? listMatches.length : 0

    let tabFixCount = 0
    const lines = text.split('\n')
    let inFence = false
    for (const line of lines) {
      if (/^```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (!inFence && line.includes('\t')) {
        tabFixCount++
      }
    }

    let fenceFixCount = 0
    for (let i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i] ?? '')) {
        if (i > 0 && lines[i - 1]?.trim() !== '') {
          fenceFixCount++
        }
        if (i < lines.length - 1 && lines[i + 1]?.trim() !== '' && !/^```/.test(lines[i + 1]!)) {
          fenceFixCount++
        }
      }
    }

    const processor = remark().use(remarkGfm)
    const result = await processor.process(text)
    const formatted = String(result)

    fixes = listFixCount + tabFixCount + fenceFixCount

    return {
      item: { text: formatted, fixes },
      meta: {
        ...env.meta,
        formatted: true,
        fixes,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}