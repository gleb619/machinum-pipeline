import { PromptVariableError, renderTemplate } from '../core/llm-prompts.js'
import { PROMPT_WORK_MODES, type PromptWorkMode } from '../core/prompt-blocks.js'
import { TRANSLATE_ALLOWED_TEMPLATE_VARS } from '../normalization/translation-prompt.js'

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

function modeVarSet(mode: PromptWorkMode, allowedVars: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = { mode }
  for (const v of allowedVars) vars[v] = ''
  return vars
}

export interface PromptSetLintOptions {
  /** Work modes the family must provide format/output blocks for. Default: all {@link PROMPT_WORK_MODES}. */
  modes?: readonly PromptWorkMode[]
  /** Placeholder names allowed in the family's templates (builder var set). */
  allowedVars?: readonly string[]
  /** Explicit required output block (e.g. `'summary.output.bullets'`) instead of per-mode blocks. */
  output?: string
}

/**
 * Validates the full set of prompt templates used by one tool family
 * (`<family>.system`, the global `llm.format.<mode>` and `<family>.output.<mode>` for every
 * work mode): every required template exists and is non-empty, lints clean with the builder's
 * allowed vars, and `<family>.system` renders with the builder's var set (a missing var would
 * throw `PromptVariableError` at render time). An output block may fall back to the single
 * `<family>.output` template when the mode-specific one is absent (composer fallback).
 * Pure; intended for tests, not runtime.
 */
export function lintPromptSet(
  family: string,
  templates: Record<string, string>,
  opts: PromptSetLintOptions = {},
): PromptIssue[] {
  const modes = opts.modes ?? PROMPT_WORK_MODES
  const issues: PromptIssue[] = []
  const required: string[] = [`${family}.system`]
  const outputNames: string[] = []
  if (opts.output !== undefined) {
    outputNames.push(opts.output)
  } else {
    for (const mode of modes) {
      const modeOutput = `${family}.output.${mode}`
      const genericOutput = `${family}.output`
      const text = templates[modeOutput] ?? templates[genericOutput]
      if (text === undefined || text.trim() === '') {
        issues.push({
          rule: 'empty-template',
          message: `prompt '${modeOutput}' is missing or empty`,
        })
      }
      outputNames.push(templates[modeOutput] !== undefined ? modeOutput : genericOutput)
    }
  }
  required.push(...modes.map((mode) => `llm.format.${mode}`), ...outputNames)
  for (const name of [...new Set(required)]) {
    const text = templates[name]
    if (text === undefined || text.trim() === '') {
      issues.push({ rule: 'empty-template', message: `prompt '${name}' is missing or empty` })
      continue
    }
    issues.push(...lintPromptTemplate(name, text, { allowedVars: opts.allowedVars }))
  }
  const system = templates[`${family}.system`]
  if (system !== undefined && system.trim() !== '') {
    for (const mode of modes) {
      try {
        renderTemplate(system, modeVarSet(mode, opts.allowedVars ?? []), `${family}.system`)
      } catch (err) {
        if (err instanceof PromptVariableError) {
          issues.push({
            rule: 'unknown-var',
            message: `'${family}.system' does not render for mode '${mode}': missing ${err.missing.join(', ')}`,
          })
        } else {
          throw err
        }
      }
    }
  }
  return issues
}

/**
 * Validates the full translate.* prompt set used by `buildTranslationPrompt`
 * (`translate.system`, the global `llm.format.<mode>` and `translate.output.<mode>` for every
 * work mode). Thin wrapper over {@link lintPromptSet}; kept for backward compatibility.
 */
export function lintTranslatePromptSet(templates: Record<string, string>): PromptIssue[] {
  return lintPromptSet('translate', templates, {
    allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS,
  })
}
