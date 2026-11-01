import { getVariable } from '@mt/core'
import type { Exchange, ToolContext, Variable } from '@mt/core'
import { readCtx } from './core/llm-config.js'

/**
 * Dynamic override resolution for the tuning constants in `constants.ts` ("tunables":
 * numbers and strings; regexes stay code-only).
 *
 * Resolution chain (first defined wins, mirroring the LLM config pattern in
 * `core/llm-config.ts`):
 *
 *   1. per-call `constants` variable on the Exchange (`{ NAME: value }`, names are the
 *      `constants.ts` export names)
 *   2. mt.json `settings.constants.<NAME>` (flat key on `ctx.run.global.settings`)
 *   3. env `MT_CONST_<NAME>` (`process.env` overlaid by `ctx.run.global.env`)
 *   4. fallback: the `constants.ts` value
 *
 * A present but invalid value throws an error citing its source
 * (`variable constants.DEFAULT_CHUNK_TARGET`, `settings.constants.DEFAULT_CHUNK_TARGET`,
 * `env MT_CONST_DEFAULT_CHUNK_TARGET`); an absent value falls through to the next layer.
 */
/** Variable carrying the per-call constant overrides (`{ NAME: value }`). */
export const VAR_CONSTANTS = 'constants'

/** Envelope part the resolver needs: only the variables (tolerates meta-only envelopes). */
export type ConstantsEnv = { variables?: Variable[] }

/** One override candidate with a human-readable source tag for error messages. */
interface ConstantCandidate {
  value: unknown
  where: string
}

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

/**
 * Collect the override candidates for `name`, highest precedence first. `ex` may be omitted
 * (settings/env layers still resolve); `ctx` may be omitted or partial (tests).
 */
function constantCandidates(
  name: string,
  ex: ConstantsEnv | undefined,
  ctx: ToolContext | undefined,
): ConstantCandidate[] {
  const out: ConstantCandidate[] = []
  const carrier = ex?.variables === undefined ? undefined : (ex as Pick<Exchange, 'variables'>)
  const map = carrier ? getVariable<Record<string, unknown>>(carrier, VAR_CONSTANTS) : undefined
  if (map !== undefined && typeof map === 'object') {
    out.push({ value: map[name], where: `variable constants.${name}` })
  }
  const view = readCtx(ctx)
  const fromSettings = view.settings[`constants.${name}`]
  if (fromSettings !== undefined) {
    out.push({ value: fromSettings, where: `settings.constants.${name}` })
  }
  const envKey = `MT_CONST_${name}`
  const fromEnv = view.env[envKey]
  if (fromEnv !== undefined && fromEnv !== '') {
    out.push({ value: fromEnv, where: `env ${envKey}` })
  }
  return out
}

function parseNum(value: unknown, where: string): number | undefined {
  if (isAbsent(value)) return undefined
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid ${where}: expected a non-negative number, got ${JSON.stringify(value)}`,
    )
  }
  return n
}

function parseStr(value: unknown, where: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${where}: expected a string, got ${JSON.stringify(value)}`)
  }
  return value
}

function resolveTuned<T>(
  name: string,
  fallback: T,
  parse: (value: unknown, where: string) => T | undefined,
  ex: ConstantsEnv | undefined,
  ctx: ToolContext | undefined,
): T {
  for (const candidate of constantCandidates(name, ex, ctx)) {
    const parsed = parse(candidate.value, candidate.where)
    if (parsed !== undefined) return parsed
  }
  return fallback
}

/**
 * Resolve a tunable numeric constant through the override chain (see the module doc).
 * Numeric strings are accepted on every layer; an invalid value throws naming its source.
 */
export function resolveTunedNum(
  name: string,
  fallback: number,
  ex?: ConstantsEnv,
  ctx?: ToolContext,
): number {
  return resolveTuned(name, fallback, parseNum, ex, ctx)
}

/**
 * Resolve a tunable string constant through the override chain (see the module doc).
 * An empty or absent value falls through; a non-string value throws naming its source.
 */
export function resolveTunedStr(
  name: string,
  fallback: string,
  ex?: ConstantsEnv,
  ctx?: ToolContext,
): string {
  return resolveTuned(name, fallback, parseStr, ex, ctx)
}
