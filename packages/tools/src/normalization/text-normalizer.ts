import { defineTool, setVariable, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

export interface TextNormalizerOptions {
  /** Drop lines made only of decorative symbols (`***`, `~~~`, `---`, ...). Default: true. */
  dropDecorativeLines?: boolean
  /** Remove whole lines that match any of these RegExp patterns. */
  patternsToRemove?: string[]
  /** Remove whole lines that contain any of these literal substrings (case-insensitive). */
  stringsToRemove?: string[]
  /** Collapse runs of blank lines to a single blank line. Default: true. */
  collapseBlankLines?: boolean
  /** Remove lines containing Cloudflare email obfuscation artifacts. Default: false. */
  stripCloudflareEmail?: boolean
  /** Dedupe adjacent repeated chapter-title lines. Default: false. */
  dedupeTitleLines?: boolean
}

/** Zero-width / invisible formatting characters. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g
/** Control characters except tab and newline (handled separately). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
/** Exotic unicode spaces (NBSP, en/em/thin space, ideographic space ...). */
const ODD_SPACES = /[   -   　\t]/g
/** Stray symbols with no place in prose. */
const USELESS = /[*~^■-◿★☆※♦❖✽✦✧]+/g
/** A line made only of decorative characters. */
const DECORATIVE_LINE = /^[\s*~=_\-#+•·■-◿★☆※♦—–.]{3,}$/
/** Common Cloudflare email-obfuscation placeholder. */
const CLOUDFLARE_EMAIL = /\[\s*email\s+protected\s*\]/i

function unifyQuotes(line: string): string {
  return line.replace(/[“”„‟«»″]/g, '"').replace(/[‘’‚‛′ʼ]/g, "'")
}

function unifyDashes(line: string): string {
  return line.replace(/[–―−]/g, '—').replace(/(?<=\S)--+(?=\S)|\s--+\s/g, '—')
}

function unifyEllipsis(line: string): string {
  return line.replace(/…/g, '...').replace(/\.(?:\s?\.){2,}/g, '...')
}

function fixPunctuation(line: string): string {
  return (
    line
      // no space before , ! ? ; and single .
      .replace(/(\S) +([,!?;])/g, '$1$2')
      .replace(/(\S) +\.(?!\.)/g, '$1.')
      .replace(/(\S) +(?=\.\.\.)/g, '$1')
      // repeated commas
      .replace(/,{2,}/g, ',')
      // space after , ! ? ; and ellipsis when a letter follows
      .replace(/([,;!?])(?=[A-Za-z])/g, '$1 ')
      .replace(/\.\.\.(?=[A-Za-z])/g, '... ')
      // "end.Next" -> "end. Next" (lowercase word, then capital + lowercase)
      .replace(/([a-z]{2,})\.(?=[A-Z][a-z])/g, '$1. ')
  )
}

/** Normalize one line (no newlines inside). */
function normalizeLine(line: string): string {
  let out = line.replace(INVISIBLE, '').replace(CONTROL, '').replace(ODD_SPACES, ' ')
  out = unifyQuotes(out)
  out = unifyDashes(out)
  out = unifyEllipsis(out)
  out = out.replace(USELESS, '')
  out = fixPunctuation(out)
  return out.replace(/ {2,}/g, ' ').trim()
}

function hasCleaningOptions(options: TextNormalizerOptions): boolean {
  return (
    options.patternsToRemove !== undefined ||
    options.stringsToRemove !== undefined ||
    options.dedupeTitleLines === true ||
    options.stripCloudflareEmail === true ||
    options.collapseBlankLines !== undefined
  )
}

function compileRemovalPatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, 'u')
    } catch (cause) {
      throw new Error(`Invalid removal pattern: ${p}`, { cause })
    }
  })
}

function removeMatchingLines(
  lines: string[],
  patterns: RegExp[],
  strings: string[],
  stripCloudflareEmail: boolean,
): string[] {
  const loweredStrings = strings.map((s) => s.toLowerCase())
  return lines.filter((line) => {
    const lower = line.toLowerCase()
    if (loweredStrings.some((s) => lower.includes(s))) return false
    if (patterns.some((re) => re.test(line))) return false
    if (stripCloudflareEmail && CLOUDFLARE_EMAIL.test(line)) return false
    return true
  })
}

/** Heuristic: is this line a chapter title / heading candidate? */
function isTitleLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 120) return false
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false
  if (/^[-*•·]\s/.test(trimmed)) return false
  return /^#/.test(trimmed) || !/[.!?]$/.test(trimmed)
}

/** Dedupe adjacent title lines, ignoring blank lines between them. */
function dedupeAdjacentTitleLines(lines: string[]): string[] {
  const out: string[] = []
  let previousTitle: string | null = null
  let pendingBlanks = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      pendingBlanks++
      continue
    }
    if (isTitleLine(raw) && previousTitle !== null && line === previousTitle) {
      // Drop only the duplicate title; keep the blank run that separates it from the body.
      continue
    }
    for (let i = 0; i < pendingBlanks; i++) out.push('')
    pendingBlanks = 0
    out.push(raw)
    previousTitle = isTitleLine(raw) ? line : null
  }
  return out
}

function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out
}

/**
 * Source cleaning: removes configured lines, strips Cloudflare email artifacts, dedupes
 * repeated chapter-title lines, and collapses blank runs. Operates before normalization.
 */
export function cleanSource(text: string, options: TextNormalizerOptions = {}): string {
  const collapse = options.collapseBlankLines ?? true
  const stripEmail = options.stripCloudflareEmail ?? false
  const dedupe = options.dedupeTitleLines ?? false
  let lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (options.patternsToRemove?.length || options.stringsToRemove?.length || stripEmail) {
    const patterns = compileRemovalPatterns(options.patternsToRemove ?? [])
    const strings = options.stringsToRemove ?? []
    lines = removeMatchingLines(lines, patterns, strings, stripEmail)
  }
  if (dedupe) {
    lines = dedupeAdjacentTitleLines(lines)
  }
  if (collapse) {
    lines = collapseBlankRuns(lines)
  }
  while (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * Heuristic, offline text normalization. Works line by line: one paragraph per line is
 * preserved (lines are never merged or split). Only decorative-only lines are dropped and
 * runs of blank lines collapse to one. `[bracketed system messages]` are kept as text.
 */
export function normalizeText(text: string, options: TextNormalizerOptions = {}): string {
  const dropDecorative = options.dropDecorativeLines ?? true
  const cleaned = hasCleaningOptions(options) ? cleanSource(text, options) : text
  const out: string[] = []
  for (const raw of cleaned.replace(/\r\n?/g, '\n').split('\n')) {
    if (dropDecorative && DECORATIVE_LINE.test(raw.replace(INVISIBLE, ''))) continue
    const line = normalizeLine(raw)
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** Variable telling whether normalization changed the text. */
export const VAR_NORMALIZED = 'normalized'

/** Create a normalizer tool with fixed options. */
export function createTextNormalizer(options: TextNormalizerOptions = {}) {
  return defineTool<string, string>({
    name: 'text-normalizer',
    version: '1.0.0',
    mdDescription:
      'Offline text normalization: unifies quotes/dashes/ellipsis, strips invisible and stray symbols, collapses spaces and blank lines, fixes punctuation spacing. Optional source cleaning: credit-line patterns, title dedupe, Cloudflare email artifacts. One paragraph per line preserved. Sets variable `normalized`.',
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
      const input = env.item
      const item = normalizeText(input, options)
      return setVariable(withItem(env, item), VAR_NORMALIZED, item !== input)
    },
  })
}

export const textNormalizer = createTextNormalizer()
