# Core Architecture: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Base Models (MVP)

| Model         | Key Fields                                              |
|---------------|---------------------------------------------------------|
| `SourceManifest` | URI string (schema determines type), variables map  |
| `Item`        | id, type, content pointer/body, metadata, current state |
| `ItemResult`  | per-state/per-tool outputs attached to item context     |
| `RunMetadata` | run id, selected pipeline, timestamps, status           |
| `StreamItem`  | [StreamItem](../core/src/main/java/machinum/streamer/StreamItem.java) — typed item: `file`, `index`, `subIndex`, `content`, `metadata` |
| `StreamCursor`| [StreamCursor](../core/src/main/java/machinum/streamer/StreamCursor.java) — resume position: `stateIndex`, `itemOffset`, `windowId` |
| `StreamError` | [StreamError](../core/src/main/java/machinum/streamer/StreamError.java) — non-fatal stream error with `ErrorType` classification |
| `StreamerCallback` | [StreamerCallback](../core/src/main/java/machinum/streamer/StreamerCallback.java) — observer-style batch consumer |
| `SourceStreamer` | [SourceStreamer](../core/src/main/java/machinum/streamer/SourceStreamer.java) — streams items from source configuration |
| `ItemsStreamer` | [ItemsStreamer](../core/src/main/java/machinum/streamer/ItemsStreamer.java) — streams items from items configuration |

> `SourceManifest` maps to the `source` block in [Pipeline YAML §4](yaml-schema.md#4-pipeline-declaration-yaml-srcmainmanifestspipelineyaml) — it represents the preprocessor acquisition layer with URI-based declaration. `Item` is the normalized unit that flows through states. See [§4.1 Source URI Schema](yaml-schema.md#41-source-uri-schema) and [§4.x source vs items](yaml-schema.md#4x-source-vs-items--data-acquisition-layer) for details.

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

**Tools Manifest Compilation:**
The tools manifest uses a simplified flat structure (no states). All tools are compiled into a single list with full configuration:

// Compile and bootstrap
CompiledToolsManifest tools = compiler.compile(rawManifest, ctx);

// In setup phase, executor bootstraps explicitly requested tools
// toolRegistry.bootstrapAll(bootstrapContext, tools.body().bootstrap());
// This orders tools by dependsOn(), runs bootstrap(), and then afterBootstrap()

// Access tool definitions for pipeline
String registryUri = tools.body().registry();  // Now a String (URI or shorthand)
for (ToolDefinition tool : tools.body().tools()) {
    // Runtime phase - runs when tool is invoked in pipeline
    ToolResult result = tool.execute(context);
}
```

See [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml) for manifest format, [Technical Design §3.2](technical-design.md#32-core-interfaces) for tool lifecycle.

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

- `body.config.execution.snapshot.enabled: true` (default)
- `body.config.execution.snapshot.mode: copy|reference` (`copy` default)

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

---

## 5. Tool Registry Architecture

The tool registry system provides a unified interface for discovering, loading, and executing tools
from different sources. All registries implement the [`ToolRegistry`](../tools/common/src/main/java/machinum/tool/ToolRegistry.java)
interface.

### 5.1 Registry Types

| Registry | Implementation | Loading Strategy | Use Case |
|----------|---------------|------------------|----------|
| **Built-in** | [`BuiltInToolRegistry`](../tools/common/src/main/java/machinum/tool/BuiltInToolRegistry.java) | Classpath scanning → Gradle build output | Local development |
| **File** | [`FileToolRegistry`](../tools/common/src/main/java/machinum/tool/FileToolRegistry.java) | JAR directory scanning | Pre-installed tools |
| **HTTP** | [`HttpToolRegistry`](../tools/common/src/main/java/machinum/tool/HttpToolRegistry.java) | HTTP download → cache → delegate to FileToolRegistry | Production/remote |

### 5.2 Built-in Tool Registry

The `BuiltInToolRegistry` uses a two-phase loading strategy:

```
Phase 1: Classpath Scanning (preferred)
├── ServiceLoader<Tool> discovers all Tool implementations on runtime classpath
├── Tools loaded via Gradle runtimeOnly dependencies
│   ├── runtimeOnly project(':tools:internal')
│   └── runtimeOnly project(':tools:external')
└── If tools found → done

Phase 2: Gradle Build Output (fallback)
├── Scan tools/{internal,external}/build/libs/*.jar
├── Create shared URLClassLoader for all JARs
└── ServiceLoader<Tool> with shared classloader
```

> **Note:** Both phases use `ServiceLoader` for SPI-based discovery. Each tool module must have a
> `META-INF/services/machinum.tool.Tool` file listing its tool implementations.
> See [Project Structure §3.1](project-structure.md#31-built-in-mode-gradle-configuration).

### 5.3 ClassLoader Isolation

All JAR-based registries (`BuiltInToolRegistry`, `FileToolRegistry`) maintain classloader isolation:

- Each JAR (or shared JAR set) gets its own `URLClassLoader`
- Before executing a tool, the thread's context classloader is swapped to the tool's classloader
- After execution, the original classloader is restored
- This prevents classpath conflicts between tools with different dependencies

### 5.4 Registry Auto-Detection

When `registry` is `null` in `tools.yaml`, the system auto-detects based on precedence:

1. `MT_BUILTIN_TOOLS_ENABLED` environment variable
2. `machinum.builtin.tools` system property
3. Presence of `build.gradle` in project root (dev mode → builtin)
4. Default fallback → HTTP registry

See [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml) for configuration,
[CLI Commands §builtin](cli-commands.md#builtin-mode-flags) for CLI usage.
