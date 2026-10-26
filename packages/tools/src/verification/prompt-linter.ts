import { PromptVariableError, renderTemplate } from '../core/llm-prompts.js'
import {
  TRANSLATE_ALLOWED_TEMPLATE_VARS,
  TRANSLATE_TEMPLATE_VARS,
  TRANSLATE_WORK_MODES,
} from '../normalization/translation-prompt.js'
import type { TranslateWorkMode } from '../normalization/translation-prompt.js'

/** One prompt-lint finding. `line` is 1-based (absent when the finding is not line-specific). */
export interface PromptIssue {
  rule: 'placeholder-syntax' | 'single-brace-var' | 'unknown-var' | 'empty-template'
  message: string
  line?: number
}

export interface PromptLintOptions {
  /** Placeholder names allowed in the template; every other `{{var}}` is flagged. */
  allowedVars?: readonly string[]
}

// {{name}} — the same shape the renderer interpolates (llm-prompts.ts PLACEHOLDER).
const VALID_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g
const INVALID_PLACEHOLDER_RE = /\{\{[^{}]*\}\}/g
const TRIPLE_BRACE_RE = /\{\{\{[^{}]*\}\}\}?/g
const SINGLE_BRACE_VAR_RE = /\{[a-zA-Z][a-zA-Z0-9._-]*\}/g

interface TextSegment {
  text: string
  /** 1-based line number where the segment starts. */
  line: number
}

/** Splits the template into prose segments outside of fenced code blocks (``` ... ```). */
function proseSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let buf: string[] = []
  let startLine = 1
  let fence = false
  const lines = text.split('\n')
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      if (!fence && buf.length > 0) {
        segments.push({ text: buf.join('\n'), line: startLine })
        buf = []
      }
      fence = !fence
      if (!fence) startLine = i + 2
      return
    }
    if (fence) return
    if (buf.length === 0) startLine = i + 1
    buf.push(l)
  })
  if (!fence && buf.length > 0) segments.push({ text: buf.join('\n'), line: startLine })
  return segments
}

/** 1-based line number of `index` within `text` (0-based char offset), offset by the segment start. */
function lineAt(seg: TextSegment, text: string, index: number): number {
  const newlines = text.slice(0, index).split('\n').length - 1
  return seg.line + newlines
}

/**
 * Lints one prompt template (pure, never throws). Rules:
 *
 * - `placeholder-syntax` — unbalanced `{{`/`}}`, invalid placeholder names, triple braces.
 * - `single-brace-var` — ST-style single-brace vars like `{text}` (machinum-llm leftover style);
 *   must be `{{text}}`. Occurrences inside fenced code blocks are ignored.
 * - `unknown-var` — a `{{var}}` not in `allowedVars` (when provided).
 * - `empty-template` — trimmed template is empty.
 */
export function lintPromptTemplate(
  name: string,
  text: string,
  opts: PromptLintOptions = {},
): PromptIssue[] {
  const issues: PromptIssue[] = []
  if (text.trim() === '') {
    issues.push({ rule: 'empty-template', message: `prompt '${name}' is empty` })
    return issues
  }
  const allowed = opts.allowedVars === undefined ? undefined : new Set(opts.allowedVars)
  for (const seg of proseSegments(text)) {
    // triple braces are checked on the raw segment: a valid {{var}} can start inside {{{var}}}
    for (const m of seg.text.matchAll(TRIPLE_BRACE_RE)) {
      issues.push({
        rule: 'placeholder-syntax',
        message: `triple braces are not allowed: ${m[0]}`,
        line: lineAt(seg, seg.text, m.index ?? 0),
      })
    }
    // mask valid + triple-brace placeholders so the remaining checks only see the leftovers
    const masked = seg.text.replace(VALID_PLACEHOLDER_RE, '').replace(TRIPLE_BRACE_RE, '')
    for (const m of masked.matchAll(INVALID_PLACEHOLDER_RE)) {
      const inner = m[0].slice(2, -2).trim()
      issues.push({
        rule: 'placeholder-syntax',
        message: `invalid placeholder ${m[0]}: name '${inner}' must match [a-zA-Z][a-zA-Z0-9._-]*`,
        line: lineAt(seg, seg.text, m.index ?? 0),
      })
    }
    const opens = (masked.match(/\{\{/g) ?? []).length
    const closes = (masked.match(/\}\}/g) ?? []).length
    if (opens !== closes) {
      issues.push({
        rule: 'placeholder-syntax',
        message: `unbalanced {{ / }} braces ({{ x${opens}, }} x${closes})`,
        line: seg.line,
      })
    }
    for (const m of masked.matchAll(SINGLE_BRACE_VAR_RE)) {
      issues.push({
        rule: 'single-brace-var',
        message: `single-brace variable ${m[0]}: use {{${m[0].slice(1, -1)}}} instead`,
        line: lineAt(seg, seg.text, m.index ?? 0),
      })
    }
    if (allowed !== undefined) {
      for (const m of seg.text.matchAll(VALID_PLACEHOLDER_RE)) {
        const varName = m[1] ?? ''
        if (!allowed.has(varName)) {
          issues.push({
            rule: 'unknown-var',
            message: `unknown placeholder {{${varName}}}`,
            line: lineAt(seg, seg.text, m.index ?? 0),
          })
        }
      }
    }
  }
  return issues
}

function modeVarSet(mode: TranslateWorkMode): Record<string, string> {
  const vars: Record<string, string> = { mode }
  for (const v of TRANSLATE_TEMPLATE_VARS) vars[v] = ''
  return vars
}

/**
 * Validates the full set of translate.* templates used by `buildTranslationPrompt`
 * (`translate.system`, `translate.format.<mode>` / `translate.output.<mode>` for every work mode):
 * every template exists and is non-empty, lints clean with the builder's allowed vars, and
 * `translate.system` renders with the builder's var set (a missing var would throw
 * `PromptVariableError` at render time). Pure; intended for tests, not runtime.
 */
export function lintTranslatePromptSet(templates: Record<string, string>): PromptIssue[] {
  const issues: PromptIssue[] = []
  const names = [
    'translate.system',
    ...TRANSLATE_WORK_MODES.flatMap((m) => [`translate.format.${m}`, `translate.output.${m}`]),
  ]
  for (const name of names) {
    const text = templates[name]
    if (text === undefined || text.trim() === '') {
      issues.push({ rule: 'empty-template', message: `prompt '${name}' is missing or empty` })
      continue
    }
    issues.push(...lintPromptTemplate(name, text, { allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS }))
  }
  const system = templates['translate.system']
  if (system !== undefined && system.trim() !== '') {
    for (const mode of TRANSLATE_WORK_MODES) {
      try {
        renderTemplate(system, modeVarSet(mode), 'translate.system')
      } catch (err) {
        if (err instanceof PromptVariableError) {
          issues.push({
            rule: 'unknown-var',
            message: `'translate.system' does not render for mode '${mode}': missing ${err.missing.join(', ')}`,
          })
        } else {
          throw err
        }
      }
    }
  }
  return issues
}
