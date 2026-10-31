/**
 * Process-level LLM mock installs (`defineProcess().install(...)`).
 *
 * LLM-backed tool factories (`createSummaryTool`, `createTitleTranslator`,
 * `createParagraphTranslator`, ...) resolve their backend at invoke time when no
 * explicit `call` / `translate` was passed. Resolution order:
 *
 * 1. explicit factory argument (`call` / `translate`) - always wins;
 * 2. `MT_LLM_TOOL` / mt.json `settings.llm.tool` naming a REAL backend
 *    (`router` | `openrouter-free` | `openrouter-pool` | `ollama`) - env/file wins
 *    over the installed mock, resolved lazily through `pickLlmTool()`;
 * 3. the installed mock provider (`defineProcess().install(mockLlm(...))`) -
 *    applies when the picked backend is `mock` (the default);
 * 4. the factory's built-in default (router proxy / `translateText`) when nothing
 *    is installed.
 *
 * The provider shape is {@link LlmChoice}, so a future router-backed stub (stub
 * answers streaming through `packages/router` like the real OpenRouter proxy)
 * plugs in here without API changes: build the choice over a router-stub gate and
 * install it the same way.
 */
import type { MockSource } from './llm-gate.js'
import { type LlmChoice, mockLlmChoice, pickLlmTool, readLlmConfig } from './llm-picker.js'

/** Options of the offline mock provider. */
export interface MockLlmOptions {
  /** Scripted answers: array (last one repeats) or `(req, index) => answer`. Default `['mock']`. */
  source?: MockSource
  /** Model reported by the mock. Default `'mock'`. */
  model?: string
}

/** An installed (or installable) process-level LLM provider. */
export interface InstalledLlmProvider extends LlmChoice {
  /** Registers this provider process-wide. Used by `defineProcess().install(...)`. */
  install(): void
}

let installed: LlmChoice | undefined
let resolved: LlmChoice | undefined
let resolvedOnce = false

/**
 * Offline mock LLM provider: scripted answers, no network. Install process-wide via
 * `defineProcess().install(mockLlm({ source }))` or `installLlmProvider(mockLlm(...))`.
 */
export function mockLlm(options: MockLlmOptions = {}): InstalledLlmProvider {
  const choice = mockLlmChoice(options.source ?? ['mock'], options.model ?? 'mock')
  return {
    ...choice,
    install: () => installLlmProvider(choice),
  }
}

/** Register a process-level LLM provider (mock or, later, a router-backed stub). */
export function installLlmProvider(provider: LlmChoice): void {
  installed = provider
  resolvedOnce = false
  resolved = undefined
}

/** Remove the installed provider (tests). */
export function uninstallLlmProvider(): void {
  installed = undefined
  resolvedOnce = false
  resolved = undefined
}

/** The currently installed provider, if any. */
export function getInstalledLlmProvider(): LlmChoice | undefined {
  return installed
}

/** Drop the cached resolution (tests; env/mt.json changes mid-process). */
export function resetProcessLlm(): void {
  resolvedOnce = false
  resolved = undefined
}

/**
 * Resolve the process-level LLM backend for a tool built WITHOUT an explicit
 * `call` / `translate`. Returns `undefined` when the factory default should apply
 * (picked backend is `mock` and nothing is installed). Cached per process.
 */
export function resolveProcessLlm(): LlmChoice | undefined {
  if (resolvedOnce) return resolved
  const config = readLlmConfig(process.env)
  resolved = config.tool === 'mock' ? installed : pickLlmTool({ env: process.env })
  resolvedOnce = true
  return resolved
}
