# Extensions
← [Architecture](../guiding/architecture.md)

## Chrome Extension

Path: `packages/chrome/`  
Manifest V3. Scrapes chapters from web editor tabs and auto-uploads them to a running `mt` backend.

### Architecture

```
packages/chrome/src/
├── background/
│   └── background.ts   # Service worker: handles messages from popup/content, manages upload state
├── content/
│   └── content.ts      # Content script: scrapePage() — DOM extraction of chapter text
├── popup/
│   └── popup.ts        # Popup UI: scrapeBtnClick, saveSettings/loadSettings, setStatus
└── messages.ts         # Message type definitions (popup ↔ background ↔ content)
```

### Communication Flow

1. User clicks "Scrape" in popup → `popup.ts` sends message to content script
2. `content.ts` runs `scrapePage()` → extracts text → sends back to popup
3. Popup forwards to `background.ts` which POSTs to `mt` backend API
4. Status shown in popup via `setStatus()`

### `messages.ts`
Typed message shapes for cross-context messaging. Always use these types — never raw `chrome.runtime.sendMessage` with untyped payloads.

### Key Constraints

- MV3: service worker (no persistent background page)
- Content scripts can only access DOM — no Node.js APIs
- Upload target: `mt` backend `/api/runs` or a configurable HTTP endpoint
- Backend URL defaults to `http://localhost:3000` — the `mt serve` admin API that serves
  `POST /api/runs/:id/items`. Port 7777 is the **router** (LLM gateway) port and has no runs API.
  The popup lets the user change the URL; `host_permissions` covers `http://localhost/*` and
  `http://127.0.0.1/*` (a portless Chrome match pattern covers every port), so a custom
  `mt serve --port <p>` works without touching the manifest.
- Does **not** import from any `@mt/*` package (browser environment)

### Tests

```
packages/chrome/tests/
└── manifest.arch.test.ts   # Validates manifest.json shape and required permissions
```

### Build

Uses `packages/chrome/vitest.config.ts` for tests only. Extension is loaded unpacked from `packages/chrome/` during development; no dedicated build step.

---

## VS Code Extension

Path: `packages/vscode/`  
Provides `mt.json` JSON schema validation, DSL hover information, and a "Run pipeline" code lens.

### Architecture

```
packages/vscode/src/
├── extension.ts          # activate()/deactivate() — registers providers
├── codelens-provider.ts  # CodeLensProvider — adds "Run pipeline" above definePipeline() calls
├── dsl-docs.ts           # DSL hover docs (pure module — no vscode import) + docsFor() lookup
└── hover-provider.ts     # HoverProvider — resolves the hovered word to DSL docs
```

### Features

**JSON Schema** (`packages/vscode/schemas/`):
- `mt.json` schema — validates `mt.json` project config files
- Registered via `contributes.jsonValidation` in `package.json`

**Hover Provider** (`hover-provider.ts` + `dsl-docs.ts`):
- `provideHover()` — resolves the word under the cursor via `document.getText(wordRange)`
- `docsFor(word, precedingChar)` (`dsl-docs.ts`) — builder ops resolve only when the word is a
  method call (preceded by `.`); `definePipeline` resolves as a plain identifier; anything else
  gets no hover
- Docs cover `definePipeline` plus the 10 builder ops (`from`, `use`, `useAll`, `to`, `batch`,
  `flatMap`, `fork`, `subflow`, `tap`, `log`) — kept in sync with `packages/core/src/dsl.ts`
- `dsl-docs.ts` is a pure module (no `vscode` import) so the lookup is unit-testable

**Code Lens Provider** (`codelens-provider.ts`):
- `provideCodeLenses()` — scans for `definePipeline()` calls
- Adds "▶ Run pipeline" code lens above each pipeline definition
- Command: triggers `mt run <file>` in terminal

### Key Constraints

- VS Code extension API only — no Node.js fs direct access, use `vscode.workspace.fs`
- Does **not** import from any `@mt/*` package (VS Code extension environment)
- Communication with running `mt` processes is via terminal commands, not direct process spawning

### Tests

```
packages/vscode/tests/
├── package.arch.test.ts   # Validates extension manifest, activationEvents, contributes
└── hover-docs.test.ts     # Hover doc lookup — every op documented, unknown words not
```

### Build

VS Code extensions use `vsce` for packaging. During development, load the extension via "Extension Development Host" in VS Code (F5).
