import { BUNDLED_PROMPTS } from '../generated/prompts.js'

/** Name of a prompt shipped inside the package (`summary.system`, `summary.user`, ...). */
export type BundledPromptName = keyof typeof BUNDLED_PROMPTS

const PROMPTS: Record<string, string> = BUNDLED_PROMPTS

/**
 * Returns a bundled prompt template.
 *
 * The texts are compiled into the package at build time (`scripts/gen-prompts.mjs`), so
 * they are available from a plain `dist` install and from the single-file `mt` binary -
 * no prompt file is read at runtime.
 *
 * @throws when no prompt with that name is bundled.
 */
export function loadBundledPrompt(name: string): string {
  const template = PROMPTS[name]
  if (template === undefined) {
    throw new Error(`Unknown bundled prompt '${name}'. Bundled: ${listBundledPrompts().join(', ')}`)
  }
  return template
}

/** Names of every bundled prompt. */
export function listBundledPrompts(): BundledPromptName[] {
  return Object.keys(PROMPTS) as BundledPromptName[]
}
