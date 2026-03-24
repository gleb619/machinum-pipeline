```markdown
# Technical Design Document: Machinum Pipeline

## 1. Project Overview

**Project Name:** machinum-pipeline

**Purpose:** A pluggable document processing orchestration engine that manages stateful pipelines with tool composition, checkpointing, and hybrid execution modes.

**Core Capabilities:**
- Process items (chapters, documents, files) through state machine–defined pipelines
- Support internal (Java) and external (Shell/Docker) tools with JSON I/O
- Provide checkpointing for resume capabilities
- Offer CLI, server, and MCP interfaces
- Include read-only admin UI for monitoring

---

## 2. Technology Stack

| Component       | Technology          | Version           |
|-----------------|---------------------|-------------------|
| Build System    | Gradle              | 8.x (Groovy DSL)  |
| Language        | Java                | 25                |
| Web Framework   | Jooby               | 4.1               |
| CLI Library     | Picocli             | 4.7+              |
| Configuration   | SnakeYAML           | 2.0+              |
| Scripting       | Groovy              | 4.0+              |
| Logging         | SLF4J + Logback     | 2.x               |
| JSON Processing | Jackson             | 2.17+             |
| Docker Client   | docker-java         | 3.4+              |
| Web UI          | Vue                 | Modern            |
| UI Build/Tests  | Vite/Vitest/Cypress | Planned (Phase 4) |

---

## 3. Directory Structure

```
work-directory/
├── seed.yaml                        # Root user configuration (also: root.yml|yaml)
├── .mt/                             # Internal directory
│   ├── tools.yaml                   # Tool definitions
│   ├── scripts/                     # External Groovy scripts
│   │   ├── conditions/
│   │   ├── transformers/
│   │   └── validators/
│   ├── tools/                       # Tool cache
│   └── state/                       # Checkpoint state
│       └── {run-id}/
│           ├── checkpoint.json
│           ├── items.json           # Collection for run processing
│           ├── metadata.json
│           ├── cache.json           # Internal tool cache for text processing
│           ├── artifacts/
│           └── run-log-{run-id}.json
├── src/
│   └── main/
│       ├── chapters/                # Input payloads or source adapters
│       │   └── en/                  # Language tag
│       │       ├── chapter_001.md
│       │       └── chapter_NNN.md
│       └── manifests/
│           ├── pipeline-a.yaml      # Pipeline declaration with tag 'a'
│           └── pipeline-b.yaml      # Pipeline declaration with tag 'b'
├── package.json                     # Generated when node tools enabled in tools.yaml
└── build/                           # Processed results and final artifacts
```

**Generation rules:**
- `machinum install` — shortcut for `download` → `bootstrap`
- `machinum install download` — resolves/fetches tool sources; MUST NOT mutate workspace layout
- `machinum install bootstrap` — creates default workspace (`.mt`, `src/main`, `build`) via internal tools; generates `package.json` if node tools are enabled

---

## 4. YAML Schema Design

### 4.1 Common Base Structure

All YAML files share this base:

```yaml
version: 1.0.0
type: pipeline|tools|root     # Discriminator
name: string
description: string           # Optional
labels:
  key: value
metadata:
  author: string
  created: timestamp
body: {}                      # Type-specific payload
```

### 4.2 Root Pipeline YAML (`root.yml`)

```yaml
version: 1.0.0
type: root
name: "Book Processing Runtime Config"
description: "Global runtime defaults and references"
labels:
  my-label: 123abc
body:
  tools: ".mt/tools.yaml"        # default
  metadata:
    book_id: my_book_123
  execution:
    parallel: false              # default
    max-concurrency: 4           # default
    resume: true                 # default
    manifest-snapshot:
      enabled: true              # default
      mode: copy                 # copy|reference; default: copy
  error-handling:
    retry:
      max-attempts: 3
      backoff:
        type: fixed              # fixed|linear|exponential; default: fixed
        initial-delay: 2s
        max-delay: 30s
        multiplier: 2.0
        jitter: 0.15
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: "ValidationException"
        strategy: skip
      - exception: ".*"
        strategy: stop
  pipeline-config:
    batch-size: 10
    window-batch-size: 5
    cooldown: 5s
    allow-override-mode: false
    tool-registry:
      type: file                 # file|http|git
      url: https://raw.githubusercontent.com/gleb619/machinum-pipeline/refs/heads/main/tools.yaml
      refresh: on_startup        # on_startup|never
  cleanup:
    success: 5d
    failed: 7d
    success-runs: 5
    failed-runs: 10
  env-files:
    - ".env"
    - ".ENV"
  env:
    API_KEY: "{{env.OPENAI_KEY}}"
    AWS_REGION: us-east-1
```

### 4.3 Tools YAML (`.mt/tools.yaml`)

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
description: "AI and utility tools"
metadata:
  created: 2020.01.01
body:
  execution-targets:
    default: local               # local|remote|docker
    targets:
      - name: local
        type: local
      - name: remote-build
        type: remote
        remote-host: build.example.internal
      - name: docker-sandbox
        type: docker
        docker-host: unix:///var/run/docker.sock

  install:
    tools:
      - name: workspace-init
        phase: bootstrap_only
        tool: fs-layout-generator
      - name: git-init
        phase: bootstrap_only
        tool: git-init-tool
      - name: node-scaffold
        phase: bootstrap_optional
        tool: node-package-generator
      - name: opencode-sandbox
        phase: bootstrap_optional
        tool: docker-compose-runner

  tools:
    - name: qwen-summary
      type: internal             # internal|external; default: internal
      version: 2.1.0             # default: latest
      execution-target: local
      source:
        type: spi                # spi|git|http|file; default: spi
        url: "https://github.com/org/qwen-summary.git"
        git-tag: v2.1.0
      cache:
        enabled: true
        key: "{{tool.name}}:{{tool.version}}:{{sha256(input)}}"
        ttl: 24h
      timeout: 30s               # default
      config:
        model: qwen2.5-72b
        temperature: 0.7
        input-schema:            # JSON Schema; validation for external tools only
          type: object
          properties:
            content: { type: string }
        output-schema:
          type: object
          properties:
            summary: { type: string }

    - name: embedding-generator
      type: external
      runtime: docker            # Experimental/post-MVP
      source:
        type: docker
        image: "https://registry.example.com/embedding:latest"
      config:
        model: bge-large
        dimension: 1024

    - name: glossary-consolidator
      source:
        type: spi
        spi-class: machinum.tools.GlossaryConsolidator
      config:
        threshold: 0.8

    # Minimal declaration — name resolves via SPI
    - name: translator

    - name: md-formatter
      type: external
      runtime: shell
      source:
        type: file
        url: "{{ '/app/some-path/script.sh' args[0] }}"
      args:
        - "{{item.id}}"
      cache:
        enabled: false
      config:
        work-dir: "{{rootDir}}"

    - name: notify-webhook
      type: external
      execution-target: remote-build
      runtime: shell
      source:
        type: file
        url: "./.mt/scripts/notifications/webhook.sh"
      config:
        endpoint: "{{env.NOTIFY_ENDPOINT}}"
        channel: pipeline-events
```

### 4.4 Pipeline Declaration YAML (`src/main/manifests/pipeline.yaml`)

> **Constraint:** Exactly one of `source` or `items` must be declared; missing both throws an exception.

```yaml
version: 1.0.0
type: pipeline
name: "complex-pipeline"
description: "Full AI pipeline with embeddings and translation"
body:
  config:
    batch-size: 10
    window-batch-size: 5
    cooldown: 5s
    allow-override-mode: false
    execution:
      mode: sequential           # sequential|parallel
      max-concurrency: 4
      runner:
        type: one_step           # one_step|batch_step|batch_step_over
        batch-size: "{{config.batch-size}}"
        step_over_cursor_key: "{{run.cursor.state_item_index}}"
      listeners:
        - name: run-log-listener
          type: internal
        - name: webhook-listener
          type: script
          path: "{{scripts/listeners/webhook-listener.groovy}}"
      interceptors:
        - name: validation-interceptor
        - name: metrics-interceptor
    runner:
      type: one_step             # one_step|batch_step|batch_step_over
      options:
        batch-size: 5
        async:
          enabled: true
          max_in_flight: 1       # MVP default for one_step
        checkpoint_cursor:
          state_index: 0
          item_offset: 0

  variables:
    book_name: my first book
    genres:                      # Comma-separated or list form accepted
      - game
      - fantasy
    status: ongoing
    tags:
      - hard-working protagonist
      - cunning protagonist

  # Exactly one of source|items required
  source:
    type: file                   # file|http|git|s3 (s3: post-MVP)
    file-location: "./input/book.pdf"
    format: md                   # folder|md|json|jsonl|pdf|docx (pdf|docx: post-MVP)
    custom-loader: "{{scripts/loaders/pdf-loader.groovy}}"
    metadata:
      book_source: "{{metadata.book_id}}"
      title: "{{extracted.title}}"

  items:
    type: chapter                # chapter|paragraph|line|document|page (document|page: post-MVP)
    custom-extractor: "{{scripts/extractors/chapter-extractor.groovy}}"
    metadata:
      book_id: "{{metadata.book_id}}"
      title: "{{extracted.title}}"

# State definitions (ordered)
states:
  # Async tools run concurrently; next sequential tool auto-waits for all prior async completions
  - name: PREPROCESS
    tools:
      - tool: language-detector
        async: true
        output-key: detected_lang
      - tool: text-normalizer
        async: true
        output-key: normalized
      - tool: content-validator
        input:
          lang: "{{detected_lang}}"
          text: "{{normalized}}"

  - name: SUMMARY
    condition: "{{ item.type != 'preface' }}"
    tools:
      - tool: qwen-summary
        input: "{{item.content}}"
        output-key: summary
      - tool: glossary-consolidator
        input: "{{previous.summary}}"
        output-key: consolidated_summary

  - name: CLEANING
    condition: "{{ scripts.conditions.should_clean(item) }}"
    tools:
      - text-cleaner             # Shorthand form

  - name: FORK_PROCESSING
    fork:
      branches:
        - name: embedding-branch
          states:
            - name: EMBED
              tools:
                - tool: embedding-generator
                  async: true
                  output-key: embedding
            - name: STORE_EMBEDDING
              tools:
                - vector-store
        - name: glossary-branch
          states:
            - name: EXTRACT_GLOSSARY
              tools:
                - glossary-extractor
            - name: CONSOLIDATE
              tools:
                - glossary-consolidator

  - name: GLOSSARY_CONSOLIDATION
    condition: "{{ consolidated_glossary.size() > 0 }}"
    tools:
      - tool: glossary-deduplicator
        input: "{{consolidated_glossary}}"
        output-key: final_glossary

  - name: TRANSLATE_TITLE
    window:
      type: tumbling
      size: "{{config.batch-size}}"
      aggregation:
        group-by: title
        tools:
          - batch-translator
        output-key: translated_titles

  - name: TRANSLATE
    tools:
      - tool: peek
        tools:                   # Tool chain; output-key receives last tool's result
          - tool: language-detector
          - tool: translator-guard
          - tool: translator
            input:
              text: "{{cleaned_text}}"
              glossary: "{{final_glossary}}"
        output-key: translated_text

  - name: COPYEDIT
    tools:
      - tool: grammar-editor
        input: "{{translated_text}}"
        output-key: final_text

  - name: FINISHED
    wait-for: "{{config.cooldown}}"

listeners:
  on_item_complete:
    - tool: md-formatter
    - tool: metrics-collector
      # non-blocking logging, because there no other tool that await the result
      async: true
  on_pipeline_complete:
    - tool: notify-webhook
      input: "{{translated_text}}"
    - log-summary                # Shorthand form

error-handling:
  default-strategy: retry
  retry-config:
    max-attempts: 3
    backoff: exponential
  strategies:
    - exception: "TimeoutException"
      strategy: retry
    - exception: "ValidationException"
      strategy: skip
    - exception: ".*"
      strategy: stop
```

**Tool declaration rules:**
- Shorthand: `- tool-name`
- Object form: `- tool: tool-name`
- `output-key` defaults to tool name if omitted
- Terminal `listeners` execute after the final state for each item

**Predefined expression variables:**

| Variable           | Description                                  |
|--------------------|----------------------------------------------|
| `item`             | Current source/items element                 |
| `text`             | Content of current element                   |
| `index`            | Element index in collection                  |
| `textLength`       | Character count                              |
| `textWords`        | Word count                                   |
| `textTokens`       | Token count via `CL100K_BASE`                |
| `aggregationIndex` | Index for window/aggregation                 |
| `aggregationText`  | Window/aggregation result (array of strings) |
| `runId`            | Active run identifier                        |
| `state`            | Current state descriptor                     |
| `tool`             | Current tool descriptor                      |
| `retryAttempt`     | Current retry number for the tool            |

---

## 5. Core Architecture

### 5.1 High-Level Components

The orchestration layer centers on a pluggable runner and event pipeline:

- **Runner subsystem:** selects `one_step`, `batch_step`, or `batch_step_over`; controls item/state iteration strategy
- **Listener chain:** receives lifecycle events (`run_start`, `state_start`, `state_success`, `state_failure`, `run_complete`)
- **Interceptor chain:** executes around state transitions for validation, metrics, tracing, and policy checks
- **Error handling subsystem:** resolves strategy from merged root/pipeline config; applies retry/skip/stop/fallback
- **Execution target abstraction:** tools execute against local, SSH, or Docker targets via a unified executor contract

```
graph TD
    subgraph CLI_Server_Layer ["CLI / Server Layer"]
        Install["install"]
        Run["run"]
        Serve["serve"]
        MCP["mcp/cli"]
        Help["help"]
    end

    subgraph Orchestration_Engine ["Orchestration Engine"]
        subgraph Pipeline_Manager ["Pipeline Execution Manager"]
            StateMachine["State Machine"]
            Checkpoint["Checkpoint"]
            ErrorHandler["Error Handler"]
        end
    end

    subgraph Tool_Registry ["Tool Registry"]
        InternalTools["Internal Tools (Java)"]
        ExternalTools["External Tools (Shell/Docker)"]
        CacheManager["Tool Cache Manager"]
    end

    subgraph Data_State_Layer ["Data & State Layer"]
        YAMLLoader["YAML Loader"]
        GroovyEngine["Groovy Engine"]
        StateStore["State Store"]
    end

    CLI_Server_Layer --> Orchestration_Engine
    Orchestration_Engine --> Tool_Registry
    Tool_Registry --> Data_State_Layer
```

### 5.2 Core Interfaces

```java
// Tool Contract
public interface Tool {
    String getName();
    Version getVersion();
    JsonNode execute(JsonNode input, ToolContext context);
}

// Internal Tool (Java SPI)
@FunctionalInterface
public interface InternalTool extends Tool {
    default String getName() {
        return this.getClass().getSimpleName();
    }
    default Version getVersion() {
        return BuildInfo.current().version();
    }
    JsonNode process(JsonNode input, ToolContext context);
}

// External Tool (base)
public abstract class ExternalTool implements Tool {
    protected final String runtime;       // shell|docker
    protected final Path workDir;
    protected final Duration timeout;
    protected final RetryPolicy retryPolicy;
    protected final ExecutionTarget target;
}

// External Tool — Shell
public class ShellTool extends ExternalTool {
    public JsonNode execute(JsonNode input, ToolContext context) {
        // ProcessBuilder-based execution
    }
}

// External Tool — Docker (experimental, post-MVP)
public class DockerTool extends ExternalTool {
    private final String image;
    private final DockerClient client;

    public JsonNode execute(JsonNode input, ToolContext context) {
        // Mount input, run container, capture stdout JSON
    }
}

// Pipeline State Machine
@Data
public class PipelineStateMachine<T> {
    private final List<StateDefinition> states;
    private final StateStore stateStore;
    private final ErrorHandler errorHandler;
    private final List<StateExecutionListener> listeners;
    private final List<StateExecutionInterceptor> interceptors;
    private final ExpressionResolver expressionResolver;
    private final PipelineRunner runner;

    public Flow<T> createFlow(List<T> items, PipelineContext context);
}

// Execution Context
@Data
public class ExecutionContext {
    private final String runId;
    private final Map<String, Object> metadata;
    private final Map<String, Object> variables;

    public Object evaluate(String expression); // resolves {{ ... }}
}

public interface StateExecutionListener {
    void onStateStart(ExecutionContext ctx, Item item, StateDefinition state);
    void onStateSuccess(ExecutionContext ctx, Item item, StateDefinition state, ItemResult result);
    void onStateFailure(ExecutionContext ctx, Item item, StateDefinition state, Exception error);
}

public interface StateExecutionInterceptor {
    default void beforeState(ExecutionContext ctx, Item item, StateDefinition state) {}
    default void afterState(ExecutionContext ctx, Item item, StateDefinition state, ItemResult result) {}
}

public interface ExpressionResolver {
    Object resolveTemplate(String template, ExecutionContext ctx); // resolves {{ ... }}
    boolean supportsInlineExpression(String value);
}

public interface ConditionEvaluator {
    boolean evaluate(String condition, ExecutionContext ctx, Item item);
}

public interface StateProcessor {
    ItemResult process(StateDefinition state, Item item, ExecutionContext ctx);
}

public interface ToolRegistry {
    Tool resolve(String toolName);
    List<Tool> list();
}

public interface ToolExecutor {
    JsonNode execute(Tool tool, JsonNode input, ToolContext context);
}

public interface CheckpointStore {
    void save(CheckpointSnapshot snapshot);
    Optional<CheckpointSnapshot> load(String runId);
}

public interface ErrorStrategyResolver {
    ErrorStrategy resolve(Exception e, ErrorHandlingConfig config);
}
```

### 5.3 Base Models (MVP)

| Model         | Key Fields                                                      |
|---------------|-----------------------------------------------------------------|
| `SourceRef`   | source type, location, format, optional loader script           |
| `Item`        | id, type, content pointer/body, metadata, current state         |
| `ItemResult`  | per-state/per-tool outputs attached to item context             |
| `RunMetadata` | run id, selected pipeline, timestamps, status                   |

### 5.4 Monitoring and Tracing (MVP)

- Structured JSON logs: `run-id`, `item-id`, `state`, `tool`, `duration-ms`
- Correlation IDs propagated from CLI/server entrypoints
- Basic counters: processed, skipped, retried, failed
- Metrics endpoint and full tracing are post-MVP

---

## 6. CLI Commands

```
machinum
├── install [tool...]                    # Install tools from tools.yaml
│   ├── download                         # Fetch tool sources (no workspace mutation)
│   └── bootstrap                        # Create workspace structure and run install scripts
├── run [pipeline-name]                  # Execute pipeline
│   ├── --resume <run-id>                # Resume from checkpoint
│   └── --dry-run                        # Validate without executing
├── cleanup                              # Clear intermediate files/logs/runs
│   ├── --run-id <run-id>                # Clean specific run
│   └── --older-than <duration>          # Clean by age
├── serve                                # Start HTTP server
│   ├── --port 8080
│   └── --ui                             # Enable admin UI
├── mcp                                  # MCP mode
│   ├── --command                        # No daemon mode
│   └── --server                         # Server mode
├── status                               # Show app status
│   └── --run-id <run-id>
├── logs                                 # Show app logs
│   └── --run-id <run-id>
└── help
```

---

## 7. Checkpointing & State Management

### 7.1 State File Structure (`.mt/state/{run-id}/checkpoint.json`)

At run start the engine snapshots effective manifests into `.mt/state/{run-id}/pipeline-{hash}.yaml`; resume uses immutable run-specific config.

Controlled by root config:
- `body.execution.manifest-snapshot.enabled: true` (default)
- `body.execution.manifest-snapshot.mode: copy|reference` (`copy` default)

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

### 7.2 Checkpoint Strategy

| Trigger                   | Action                          |
|---------------------------|---------------------------------|
| After each item state     | Save item progress              |
| After batch/window        | Save batch results              |
| SIGTERM                   | Save full state                 |
| Resume                    | Load checkpoint, skip completed |

**Cleanup policy defaults** (configurable in root config):
- Keep successful/failed run state per configured duration
- Keep latest N successful runs per pipeline (default: 5)
- Manual: `machinum cleanup --run-id <id>` or `--older-than <duration>`

---

## 8. Admin UI (Read-Only)

> Write/action endpoints are post-MVP.

### 8.1 Routes (Jooby)

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

### 8.2 UI Features

> Tool-provided custom web components are post-MVP.

- Real-time status via SSE
- Pipeline visualization (state graph)
- Item progress bars
- Log viewer with filtering
- Tool registry browser

---

## 9. Execution Models

### 9.1 Sequential Execution

Base algorithm of `one_step` runner. Other runners reuse the same state transition contract and vary only in item/window loading strategy.

```java
for (Item item : items) {
    for (State state : pipeline.getStates()) {
        if (conditionMet(item, state)) {
            processState(item, state);
            checkpoint();
        }
    }
}
```

### 9.2 Parallel Execution (Future)

All runners use async primitives internally. For MVP, `one_step` constrains `max_in_flight = 1` for deterministic behavior.

```java
ExecutorService executor = Executors.newFixedThreadPool(maxConcurrency);
List<CompletableFuture<Void>> futures = items.stream()
    .map(item -> CompletableFuture.runAsync(() -> processItem(item), executor))
    .collect(toList());
CompletableFuture.allOf(futures).join();
```

### 9.3 Fork/Sub-Pipeline (Future)

```yaml
fork:
  - name: parallel-embedding
    states: [EMBEDDING]
    mode: parallel
    sub-pipeline: embedding-pipeline.yaml
```

---

## 10. Error Handling

### 10.1 Error Strategies

| Strategy   | Behavior                                |
|------------|-----------------------------------------|
| `stop`     | Abort entire pipeline, save checkpoint  |
| `skip`     | Skip current item, continue with next   |
| `retry`    | Retry current tool with backoff         |
| `fallback` | Use fallback tool/value                 |

### 10.2 Exception Classification

```java
public class ErrorHandler {
    public ErrorStrategy determineStrategy(Exception e, ErrorHandlingConfig config) {
        // Match exception type against configured strategies
        // Apply default if no match
    }

    public void handle(ExecutionContext ctx, Exception e, ErrorStrategy strategy) {
        switch (strategy) {
            case RETRY    -> scheduleRetry(ctx);
            case SKIP     -> markItemSkipped(ctx);
            case STOP     -> shutdownAndCheckpoint(ctx);
        }
    }
}
```

---

## 11. Groovy Scripting Integration

### 11.1 Evaluation Context

```java
public class GroovyEvaluator {
    private final ScriptEngine engine;
    private final Map<String, Object> binding;

    public Object evaluate(String expression, ExecutionContext ctx) {
        // Parse {{ ... }} via regex → ${}
        // Bind variables: item, context, metadata, previous, env, scripts
    }

    public Object evaluateFile(Path scriptPath, ExecutionContext ctx) {
        // Load .groovy file, evaluate with same binding
    }
}
```

### 11.2 Available Bindings

| Variable           | Description                              |
|--------------------|------------------------------------------|
| `item`             | Current item being processed             |
| `context`          | Pipeline execution context               |
| `metadata`         | Pipeline metadata                        |
| `previous`         | Output from previous tool                |
| `env`              | Environment variables                    |
| `scripts`          | External script loader                   |
| `state`            | Current state definition                 |
| `tool`             | Current tool definition                  |
| `runId`            | Active run id                            |
| `index`            | Current item index                       |
| `text`             | Current item text/content                |
| `textWords`        | Word count                               |
| `textTokens`       | Token count (`CL100K_BASE`)              |
| `aggregationIndex` | Active window index                      |
| `aggregationText`  | Window aggregation payload               |

---

## 12. Project Structure (Gradle)

> Module split reflects target architecture; docs may lead implementation during bootstrap.

```
machinum-pipeline/
├── build.gradle
├── settings.gradle
├── README.md
├── docs/
│   ├── tdd.md
│   └── build-configuration.md
├── core/
│   ├── src/main/java/machinum/
│   │   ├── pipeline/
│   │   ├── tool/
│   │   ├── state/
│   │   ├── yaml/
│   │   ├── groovy/
│   │   └── checkpoint/
│   └── src/test/java/
├── cli/
│   ├── src/main/java/machinum/cli/
│   └── src/test/java/
├── server/
│   ├── src/main/java/machinum/server/
│   ├── src/main/resources/webapp/
│   └── src/test/java/
├── tools/
│   ├── common/                          # Shared adapters, execution abstractions, contracts
│   ├── internal/                        # Built-in internal tools
│   │   ├── text/
│   │   ├── glossary/
│   │   └── notify/
│   └── external/                        # External wrappers (shell/docker/ssh)
├── ui/                                  # Planned
│   ├── admin-ui/
│   ├── vscode-extension/
│   └── shared-components/
└── mcp/
    └── src/main/java/machinum/mcp/
```

---

## 13. Build Configuration

See [build-configuration.md](build-configuration.md) for full details.

---

## 14. Roadmap & Phases

### Phase 1: Core Foundation (MVP)
- YAML loading with unified `body` manifests
- Tool registry with internal tool support
- Sequential state machine execution
- Basic CLI (`run`, `help`, `status`, `logs`)
- Simple checkpointing with optional `items.json` split
- Logging infrastructure
- `.env`/`.ENV` runtime environment loading

### Phase 2: External Tools & Caching
- Shell-based external tool execution
- Tool source resolution (git, HTTP, file)
- Tool caching and versioning
- `install` command (`download` + `bootstrap`)
- Cleanup policies and `cleanup` command

### Phase 3: Advanced Pipeline Features
- Parallel execution (per-item)
- Windowing and aggregation
- Fork/sub-pipeline support
- Full checkpoint/resume
- Groovy scripting with external scripts
- Docker tool execution (experimental → stable)

### Phase 4: Server & UI
- Jooby server implementation
- Admin UI
- SSE for real-time updates
- MCP server mode
- Interactive CLI mode
- Tool-provided UI components

---

## 15. Non-Functional Requirements

| Requirement       | Target                                                |
|-------------------|-------------------------------------------------------|
| **Performance**   | <100ms overhead per item (excluding tool execution)   |
| **Scalability**   | 10,000+ items per pipeline                            |
| **Reliability**   | Checkpoint every 30s; resume within 1 minute          |
| **Observability** | Structured logging, trace IDs, metrics endpoint       |
| **Security**      | Docker isolation, no root required, config validation |
| **Compatibility** | Java 25; Linux/macOS primary, Windows secondary       |

---

## 16. Open Items & Future Considerations

1. **State store backend** — Start with filesystem; evaluate Redis for distributed scenarios
2. **Pipeline composition** — Reference sub-pipelines from other YAMLs
3. **Metrics** — Prometheus integration
4. **Authentication** — For server mode and admin UI
5. **Tool SDK** — Java annotations for easier internal tool development
6. **Webhook triggers** — Start pipelines from external events
7. **Action endpoints** — Controlled run actions from admin UI/API (post read-only MVP)
8. **Fork execution DSL** — Clear syntax for sub-pipeline orchestration

---

**Document Version:** 1.4
**Last Updated:** 2026-03-24
**Status:** Approved for Phase 1 Development
```