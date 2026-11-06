# Mock / stub LLM tooling

← [Architecture](architecture.md)

How to run LLM-backed tools (`summary`, `entities`, `schema`, title/paragraph
translators, …) without real model calls: offline scripted mocks, slot overrides,
and the process-level install (`defineProcess().install(...)`).

## Current state (building blocks)

### `pickLlmTool()` — the single config point

`packages/tools/src/core/llm-picker.ts` exports `pickLlmTool({ env, mockSource, configPath })`,
`readLlmConfig` and `LLM_TOOLS`. One pick configures every LLM-backed tool of a pipeline:

- `MT_LLM_TOOL` = `router` | `openrouter-free` | `openrouter-pool` | `ollama` | `mock`
  (default `mock` — offline, no API key, no router).
- `MT_LLM_MODEL` picks the model (default: the backend's own).
- `MT_LLM_USE` / mt.json `settings.llm.use` route through a vault entry.
- mt.json `settings.llm.tool` / `settings.llm.model` are the file-based fallback; env wins.
  `imports` (e.g. a gitignored `mt.local.json`) merge in first.

The returned `LlmChoice` is `{ tool, model, gate, schemaCall, translate }` — the gate, the
`call` backend for the schema-doc tools, and the `translate` slot for the chapter translators.

### Mock backend = gate with a swapped `call` slot

The gate (`packages/tools/src/core/llm-gate.ts`) is a composable tool with slots
`prepare → fit → call → parse → emit`. The mock backend is the stock gate with the `call`
slot replaced by scripted answers:

```typescript
llmGate.with({ call: mockLlmCall(mockSource) })
```

`mockLlmCall(source)` accepts an array (last answer repeats) or `(req, index) => answer`;
it never touches the network and records every request on `.calls`.

### Slot overrides on any composable tool

`defineComposableTool` (packages/core/src/dsl.ts) builds tools from named, ordered slots;
`tool.with({ slot })` returns a NEW tool with one slot replaced. Example:
`schemaDocWriter.with({ emit: stubSchemaEmit })` in
`samples/sample1-tutorial/pipelines/pipe09-llm-tools.ts` swaps the `call` slot of
`statTranslateDict` with `mockLlmCall(...)`, so the offline gallery still exercises the gate.

## Process-level install: `defineProcess().install(mocks)`

Pipeline files no longer need the `pickLlmTool` ceremony. Two pieces:

- `defineProcess()` (`@mt/core`, next to `definePipeline`) — process-level DSL entry point.
  `.install(...)` applies installers **at pipeline-module load** (before the Runner starts);
  `.pipeline(p)` returns the pipeline unchanged for the default export.
- `mockLlm({ source, model? })` (`@mt/tools`, `core/llm-install.ts`) — an offline mock LLM
  provider (`LlmChoice` + an `install()` hook) that registers itself process-wide.

```typescript
import { definePipeline, defineProcess } from '@mt/core'
import { createSummaryTool, createTitleTranslator, mockLlm } from '@mt/tools'

// Tools are built WITHOUT call/translate wiring...
const summary = createSummaryTool()
const titles = createTitleTranslator()

export default defineProcess()
  .install(mockLlm({ source: (req) => `mock: ${req.messages.at(-1)?.content}` }))
  .pipeline(definePipeline().from('jsonl://./input.jsonl').use(summary).to('md://./out'))
```

### How it works

LLM-backed factories resolve their backend **at invoke time** when no explicit
`call` / `translate` was passed, via `resolveProcessLlm()` (`core/llm-install.ts`).
Resolution order (first match wins):

1. **Explicit factory argument** (`createSummaryTool({ call })`, `createTitleTranslator({ translate })`) — always wins.
2. **`MT_LLM_TOOL` / mt.json `settings.llm.tool` naming a real backend**
   (`router` | `openrouter-free` | `openrouter-pool` | `ollama`) — env/file beats the
   installed mock; the backend is resolved lazily through `pickLlmTool()`.
3. **The installed mock provider** — applies when the picked backend is `mock` (the default).
4. **The factory default** (router proxy / `translateText`) when nothing is installed.

So `MT_LLM_TOOL=ollama mt run …` runs the very same pipeline file against the real
backend; with no env set, the installed mock answers everything offline.

The schema-doc tools share one chokepoint (`runPromptWithRetry` in
`normalization/schema/llm.ts`): without an explicit `call`, it uses
`resolveProcessLlm()?.schemaCall` (and the provider's model when the tool option does
not set one). The translators wrap their default `translate` slot in an invoke-time
lookup with the same precedence.

Registry helpers (mostly for tests): `installLlmProvider`, `uninstallLlmProvider`,
`getInstalledLlmProvider`, `resetProcessLlm`.

### Forward-looking: router-backed stubs (not implemented yet)

A future session will add a stub mode whose answers **stream through `packages/router`**
like the real OpenRouter proxy (same HTTP path, same cost/usage accounting, scripted
upstream). The install API is shaped for it: a provider is just an `LlmChoice`, so a
router-stub provider — a gate over a router pointing at a stub upstream, packaged as
`mockRouter(...)` / `installLlmProvider(...)` — plugs into `defineProcess().install(...)`
and `resolveProcessLlm()` with no changes to tool factories or pipeline files.
