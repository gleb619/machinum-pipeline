# Core Architecture: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Base Models (MVP)

| Model         | Key Fields                                              |
|---------------|---------------------------------------------------------|
| `SourceRef`   | source type, location, format, optional loader script   |
| `Item`        | id, type, content pointer/body, metadata, current state |
| `ItemResult`  | per-state/per-tool outputs attached to item context     |
| `RunMetadata` | run id, selected pipeline, timestamps, status           |

---

## 1.5 Compiled Models

At runtime, YAML manifests are compiled to optimized POJOs with lazy expression evaluation. See [Value Compilers](value-compilers.md) for complete documentation.

| Raw YAML Model     | Compiled Model             | Compiler                   |
|--------------------|----------------------------|----------------------------|
| `ToolDefinition`   | `CompiledToolDefinition`   | `ToolDefinitionCompiler`   |
| `StateDefinition`  | `CompiledStateDefinition`  | `StateDefinitionCompiler`  |
| `PipelineManifest` | `CompiledPipelineManifest` | `PipelineManifestCompiler` |
| `RootManifest`     | `CompiledRootManifest`     | `RootManifestCompiler`     |
| `ToolsManifest`    | `CompiledToolsManifest`    | `ToolsManifestCompiler`    |

**Key Types:**
- `CompiledValue<T>` - Lazy-evaluating wrapper for expression-containing values
- `CompiledMap` - Map wrapper with expression value support
- `CompilationContext` - Shared state during compilation

**Example:**
```java
// Load compiled pipeline
CompiledPipelineManifest pipeline = loader.loadCompiledPipelineManifest(path, ctx);

// Evaluate state condition
for (CompiledStateDefinition state : pipeline.getPipelineStates()) {
    if (state.evaluateCondition()) {  // Groovy expression
        // Process tools
    }
}
```

---

## 2. Monitoring and Tracing (MVP)

- Structured JSON logs: `run-id`, `item-id`, `state`, `tool`, `duration-ms`
- Correlation IDs propagated from CLI/server entrypoints
- Basic counters: processed, skipped, retried, failed
- Metrics endpoint and full tracing are post-MVP

---

## 3. Checkpointing & State Management

### 3.1 State File Structure (`.mt/state/{run-id}/checkpoint.json`)

At run start the engine snapshots effective manifests into `.mt/state/{run-id}/pipeline-{hash}.yaml`; resume uses
immutable run-specific config.

Controlled by root config:

- `body.config.execution.manifest-snapshot.enabled: true` (default)
- `body.config.execution.manifest-snapshot.mode: copy|reference` (`copy` default)

For `batch_step_over`/`batch`, checkpoint MUST include a deterministic cursor:

- `runner.state_index` — active state position
- `runner.item_offset` — first unprocessed item in current window
- `runner.window_id` — active batch/window identity

```json
{
  "run-id": "20250321-abc123",
  "pipeline": "complex-pipeline",
  "started-at": "2025-03-21T10:00:00Z",
  "last-updated": "2025-03-21T10:15:30Z",
  "status": "running",
  "items-file": "items.json",
  "items": [
    {
      "id": "chapter-01",
      "state": "SUMMARY",
      "progress": 100,
      "metadata": { "title": "Introduction", "page": 1 },
      "results": { "summary": "...", "embedding": [] },
      "error": null
    },
    {
      "id": "chapter-02",
      "state": "TRANSLATE",
      "progress": 45,
      "metadata": {},
      "results": {}
    }
  ],
  "context": {
    "variables": {},
    "batch-buffer": []
  }
}
```

> Large runs SHOULD keep item payloads in `.mt/state/{run-id}/items.json`; `checkpoint.json` serves as index/summary.

### 3.2 Checkpoint Strategy

| Trigger               | Action                          |
|-----------------------|---------------------------------|
| After each item state | Save item progress              |
| After batch/window    | Save batch results              |
| SIGTERM               | Save full state                 |
| Resume                | Load checkpoint, skip completed |

**Cleanup policy defaults** (configurable in root config):

- Keep successful/failed run state per configured duration
- Keep latest N successful runs per pipeline (default: 5)
- Manual: `machinum cleanup --run-id <id>` or `--older-than <duration>`

---

## 4. Admin UI (Read-Only)

> Write/action endpoints are post-MVP.

### 4.1 Routes (Jooby)

```
GET  /                        → Dashboard (running pipelines)
GET  /pipelines               → List available pipelines
GET  /pipelines/{name}        → Pipeline definition
GET  /runs                    → List executions
GET  /runs/{run-id}           → Execution details
GET  /runs/{run-id}/items     → Items with status
GET  /runs/{run-id}/logs      → Tail logs
GET  /runs/{run-id}/stream    → Real-time SSE stream
GET  /tools                   → Installed tools
GET  /health                  → Health check
```

### 4.2 UI Features

> Tool-provided custom web components are post-MVP.

- Real-time status via SSE
- Pipeline visualization (state graph)
- Item progress bars
- Log viewer with filtering
- Tool registry browser
