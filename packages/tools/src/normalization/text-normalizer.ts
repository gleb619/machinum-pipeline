import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

export interface TextNormalizerOptions {
  /** Drop lines made only of decorative symbols (`***`, `~~~`, `---`, ...). Default: true. */
  dropDecorativeLines?: boolean
}

/** Zero-width / invisible formatting characters. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g
/** Control characters except tab and newline (handled separately). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
/** Exotic unicode spaces (NBSP, en/em/thin space, ideographic space ...). */
const ODD_SPACES = /[   -   　\t]/g
/** Stray symbols with no place in prose. */
const USELESS = /[*~^■-◿★☆※♦❖✽✦✧]+/g
/** A line made only of decorative characters. */
const DECORATIVE_LINE = /^[\s*~=_\-#+•·■-◿★☆※♦—–.]{3,}$/

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

/**
 * Heuristic, offline text normalization. Works line by line: one paragraph per line is
 * preserved (lines are never merged or split). Only decorative-only lines are dropped and
 * runs of blank lines collapse to one. `[bracketed system messages]` are kept as text.
 */
export function normalizeText(text: string, options: TextNormalizerOptions = {}): string {
  const dropDecorative = options.dropDecorativeLines ?? true
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (dropDecorative && DECORATIVE_LINE.test(raw.replace(INVISIBLE, ''))) continue
    const line = normalizeLine(raw)
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** Create a normalizer tool with fixed options. */
export function createTextNormalizer(options: TextNormalizerOptions = {}) {
  return defineTool<string, string>({
    name: 'text-normalizer',
    version: '1.0.0',
    mdDescription:
      'Offline text normalization: unifies quotes/dashes/ellipsis, strips invisible and stray symbols, collapses spaces and blank lines, fixes punctuation spacing. One paragraph per line preserved. Sets `meta.normalized`.',
    async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
      const item = normalizeText(env.item, options)
      return { item, meta: { ...env.meta, normalized: item !== env.item } }
    },
  })
}

export const textNormalizer = createTextNormalizer()
