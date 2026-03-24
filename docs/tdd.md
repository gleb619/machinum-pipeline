# Technical Design Document: Machinum Pipeline

## 1. Project Overview

**Project Name:** machinum-pipeline

**Purpose:** A pluggable document processing orchestration engine that manages stateful pipelines with tool composition, checkpointing, and hybrid execution modes.

**Core Capabilities:**
- Process items (chapters, documents, files) through state machine–defined pipelines
- Support internal (Java) and external (Docker) tools with JSON I/O
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

//TODO: enrich next project structure, add there a package.json and folders src/main, src/test
        desired folder strucutre must be created by some tool on install. package.json creation also depends on some 
        other tool

```
work-directory/
├── mt-pipeline.yaml                 # Root user configuration
├── .mt/                             # Internal directory
│   ├── tools.yaml                   # Tool definitions
│   ├── pipeline.yaml                # Pipeline declaration
│   ├── pipelines/                   # Multiple pipeline definitions (future)
│   ├── scripts/                     # External Groovy scripts
│   │   ├── conditions/
│   │   ├── transformers/
│   │   └── validators/
│   ├── cache/                       # Tool cache
│   │   └── tools/
│   └── state/                       # Checkpoint state
│       └── {run-id}/
│           ├── checkpoint.json
│           ├── items.json           # Collection for run processing
│           ├── metadata.json
│           ├── cache.json           # Internal cache of tool, for text processing
│           ├── artifacts/
│           └── run-log-{run-id}.json  # Log must be in json format
├────── logs/
│       └── machinum.log
├── src/  #TODO: add here expanded structure
└─── build/                            # Processed results

#TODO add here a package.json too, that will be added by some tool

```

//TODO: move `tools.yaml` to src folder, `pipeline.yaml` to `src/main`. And rename `output` to `build`


---

## 4. YAML Schema Design

### 4.1 Common Base Structure

All YAML files share this base structure:

```yaml
version: 1.0.0
type: pipeline|tools|root          # Discriminator
name: string                        # Human-readable name
description: string                 # Optional description
labels:                             # Key-value tags
  key: value
metadata:                           # Extended metadata
  author: string
  created: timestamp
body: {}                              # Type-specific payload

```

### 4.2 Root Pipeline YAML (`mt-pipeline.yaml`)

```yaml
version: 1.0.0
type: root
name: "Book Processing Runtime Config"
description: "Global runtime defaults and references"
labels:
  my-label: 123abc
body:
  manifests:
    tools: ".mt/tools.yaml"
    pipelines_dir: ".mt/pipelines"   # e.g. optional, use current path as default
  metadata:
    book_id: my_book_123
  execution:
    parallel: false                # default value
    max-concurrency: 4             # default value
    resume: true                   # default value
    error-strategy: stop|skip|retry
    max-retries: 3                 # default value
    #TODO redo retry to something better with backoff
    retry-delay: 5s                

#TODO add error_handling

  # Environment variables
  env-files:
    - ".env"
    - ".ENV"
  env:
    API_KEY: "{{env.OPENAI_KEY}}"
    AWS_REGION: us-east-1

#TODO: add here some clean up config
```

### 4.3 Tools YAML (`.mt/tools.yaml`)

//TODO: add here some system config where it must be executed. Like local|remote|docker stuff, where we have other 
        place where we can execute it. So project could be placed locally, and we can run all in other pc. Via http 
        or via ssh

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
description: "AI and utility tools"
metadata:                           
  created: 2020.01.01
body:
  //TODO START
  add here installation config, e.g. this file provide info about tools itself, and allow to execute them
  with some cli command. For example we could have a 'git-tool' that create git repository in configured folder. And we
  need something like `install` subcommand, that execute tools with correspondent configuration. Not all tools will
  have such, only several. So we have tools that will be used only on bootstrap, tools for runtime, and some hybrid ones
  
  Add here tools for git init, a one for add a opencode via docker-compose, one to create folder structure
  
  And add universal one that accept in config some long/muliline yaml command to run commands
  And add universal docker tool that run unserval command in docker sandbox
  //TODO END
  
  tools:
    - name: qwen-summary
      type: internal|external    #internal by default
      version: 2.1.0             #latest by default
      source:
        type: spi|git|http|file  #spi by default
        url: "https://github.com/org/qwen-summary.git"
        git-tag: v2.1.0          #git specific config
      #TODO: add explanation for cache: that field describe should we reevaludate tool or not. For example for docker we can check state of container and start if it stopped, etc, e.g.
      cache: true                # default value
      timeout: 30s               # default value
      #TODO: redo to retry with backoff
      retry: 2
      config:
        model: qwen2.5-72b
        temperature: 0.7
        input-schema:              # JSON schema for validation of external data only
          type: object
          properties:
            content: { type: string }
        output-schema:
          type: object
          properties:
            summary: { type: string }

    - name: embedding-generator
      type: external
      runtime: docker            # Docker runtime is experimental/post-MVP
      source:
        type: docker
        image: "https://registry.example.com/embedding:latest"
      config:
        model: bge-large
        dimension: 1024

    - name: glossary-consolidator
      spi-class: machinum.tools.GlossaryConsolidator
      source:
        type: spi
      config:
        threshold: 0.8
    
    # Or tool can be declared with minimal info and defaults, due in spi we have a tool name
    - name: translator 

    - name: md-formatter
      type: external
      runtime: shell
      source:
        type: file
        #TODO: we need allow here names and numbers, if we doenst know name of param
        url: "{{ '/app/some-path/script.sh' $1 }}"
      cache: false
      config:
        work-dir: {{rootDir}}
    
    #TODO Add here extenal tool for notification 
```

### 4.4 Pipeline Declaration YAML (`.mt/pipeline.yaml`)

One of keys source|items must be declared or exception need to throw

```yaml
version: 1.0.0
type: pipeline
name: "complex-pipeline"
description: "Full AI pipeline with embeddings and translation"
body:
  config:
    batch_size: 10
    window_batch_size: 5
    cooldown: 5s
    allow_override_mode: false
  variables:
    book_name: my first book
    genres:                                                         # Also we need allo to declare via comma 
      - game
      - fantasy
    status: ongoing
    tags: 
      - hard-working protagonist
      - cunning protagonist 
  source:                                                           # Alternative for items
    type: file|http|git|s3                                          # S3 only for post MVP, NOT ON START
    file-location: "./input/book.pdf"                               # Only for file type
    format: folder|md|json|jsonl|pdf|docx                           # Pdf|docx for post MVP, NOT ON START
    custom-loader: "{{scripts/loaders/pdf-loader.groovy}}"          # By default we use some code, or allow to load via groovy script
    metadata:
      book_source: "{{metadata.book_id}}"
      title: "{{extracted.title}}"
  items:                                                            # Alternative for source
    type: chapter|paragraph|line|document|page                      # document|page only for post MVP, NOT ON START
    custom-extractor: "{{scripts/extractors/chapter-extractor.groovy}}"
    metadata:
      book_id: "{{metadata.book_id}}"
      title: "{{extracted.title}}"
  tool-registry:
    type: file|http|git
    url: https://raw.githubusercontent.com/gleb619/machinum-pipeline/refs/heads/main/tools.yaml
    refresh: on_startup|never

#TODO add here listeneres and interceptors

# State definitions (ordered)
states:
  - name: SUMMARY
    condition: "{{ item.type != 'preface' }}"  # Inline Groovy
    tools:
      - tool: qwen-summary
        input: "{{item.content}}"
        output-key: summary
      - tool: glossary-consolidator
        input: "{{previous.summary}}"
        output-key: consolidated_summary

  - name: CLEANING
    condition: "{{ scripts.conditions.should_clean(item) }}"  # External script
    tools:
      - tool: text-cleaner
        input: "{{item.content}}"
        output-key: cleaned_text

  - name: EMBEDDING
    tools:
      - embedding-generator              # simplified single-tool declaration

  - name: GLOSSARY
    tools:
      - tool: glossary-extractor
        # input defaults to name `text`, e.g. it's content of source|item element 
        # output-key defaults to tool name when omitted
      - tool: glossary-consolidator
        input: "{{glossary}}"
        output-key: consolidated_glossary
      #TODO: add here a execution config, to configure tools, and a tool chain to work in parallel
        
        

  - name: GLOSSARY_CONSOLIDATION
    condition: "{{ consolidated_glossary.size() > 0 }}"
    tools:
      - tool: glossary-deduplicator
        input: "{{consolidated_glossary}}"
        output-key: final_glossary

  - name: TRANSLATE_TITLE
    window:
      type: tumbling
      size: "{{config.batch_size}}"
      aggregation:
        group-by: title
        tools: 
          - batch-translator
        output-key: translated_titles

  - name: TRANSLATE
    tools:
      - tool: translator
        input:
          text: "{{cleaned_text}}"
          glossary: "{{final_glossary}}"
        #TODO: add here sub tool call, with 3d level max
        output-key: translated_text

  - name: COPYEDIT
    tools:
      - tool: grammar-editor
        input: "{{translated-text}}"
        output-key: final_text

  - name: FINISHED
    wait-for: "{{config.cooldown}}"

#TODO redo to finalize to listeners instead
finalize:
  tools:
    - md-formatter
    - name: notify
      input: "{{translated_text}}"

#TODO add error_handling to root yaml too, and rewrite next part, say we can override error_handling if needed
# Error handling (global)
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

#TODO: redo next to `execution` and say that we can override if needed or use defautls from root.yaml
# Parallel execution
parallel:
  enabled: true
  max-forks: 4
  mode: per-item                       # per_item|per_state_group
  state-groups:
    - name: embedding_group
      states: [EMBEDDING, GLOSSARY]
      strategy: parallel
    - name: translation_group
      states: [TRANSLATE, COPYEDIT]
      strategy: sequential
      
#TODO redo to finalize listeneres
terminal-operations:
  - save:
      path: "{{build/final/{{item.id}}.json}}"
  - notify:
      script: "{{scripts/notifications/complete.groovy}}"
  - log-summary:
      enabled: true

#TODO add here a runner config, we could have next types of runners:
#  OneStep - Sequential item processing with state transitions. We load all items in memory here
#  BatchStep - Configurable batch/chunk sizes for memory-efficient processing, to not store all items in memory. It inline with window aggregation (default one)
#  BatchStepOver - Diff from BatchStep we can iterate not 'horizontally' but 'vertically'. For example we have 10 
  items and 2 states. With batch = 5 we first need to process 10 items in first state then go to second one. With Step 
  over we can process first state with 5 items, then process state 2 with that 5 items. And then return to first 
  state and process next 5 items for first state.
  - Like in origin it must be 
      S1: 5 
      S1: 5 
      S2: 5 
      S2: 5 
  - Like in step over 
      S1: 5 
      S2: 5 
      S1: 5 
      S2: 5 
```

Rules:
- Tool declaration supports both forms: string shorthand (`- tool-name`) and object form (`- tool: tool-name`).
- `output-key` is optional for single-tool stage output; default value is the tool name. 
- Terminal operations execute after the final state for each item.
- //TODO add here some info about predefined variables, like:
  - item - a source|items element
  - text - a content of source|items element
  - index - a index of element in collection
  - textLength - count of characters
  - textWords - count of words in text
  - textTokens - count of tokens via `CL100K_BASE`
  - aggregationIndex - a index for window/aggregation stuff
  - aggregationText - a window/aggregation result, a array of strings

//TODO: add missing info here, if case we forgot something

---

## 5. Core Architecture

### 5.1 High-Level Components

TODO: add here info about runner/listneres/interceptos/error handling. And local|remote stuff too

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
        InternalTools["Internal Tools<br/>(Java Classes)"]
        ExternalTools["External Tools<br/>(Shell/Docker)"]
        CacheManager["Tool Cache<br/>Manager"]
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

// Internal Tool (Java)
@FunctionalInterface
public interface InternalTool implements Tool {
   default String getName() {
    return this.getClass().getSimpleName();
   }

   default Version getVersion() {
     return //TODO add here some BuildInfo stuff, redo build.gradle add there plugin that generate file in resources with project version|git info
   }
  
   JsonNode process(JsonNode input, ToolContext context);
}

// External Tool (base)
public abstract class ExternalTool implements Tool {
    protected final String runtime; // shell|docker
    protected final Path workDir;
    //TODO: add here some config
}

// External Tool (Shell)
public class ShellTool extends ExternalTool {
    public JsonNode execute(JsonNode input, ToolContext context) {
        // Use process builder here
    }
}
// External Tool (Docker) - Experimental, post-MVP
public class DockerTool extends ExternalTool {
    private final String image;
    private final DockerClient client;
    
    public JsonNode execute(JsonNode input, ToolContext context) {
        // Mount input, run container, capture stdout JSON
    }
}

// Pipeline State Machine
public class PipelineStateMachine<T> {
    private final List<StateDefinition> states;
    private final StateStore stateStore;
    private final ErrorHandler errorHandler;
    private final List<StateExecutionListener> listeners;
    private final List<StateExecutionInterceptor> interceptors;
    private final ExpressionResolver expressionResolver;
    //TODO: add runner
    
    public Flow<T> createFlow(List<T> items, PipelineContext context);
}

// Execution Context
public class ExecutionContext {
    private final String runId;
    private final Map<String, Object> metadata;
    private final Map<String, Object> variables;
    
    public Object evaluate(String expression);  // {{ ... }} support
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

- `SourceRef`: source type, location, format, optional loader script
- `Item`: id, type, content pointer/body, metadata, current state
- `ItemResult`: per-state/per-tool outputs attached to item context
- `RunMetadata`: run id, selected pipeline, timestamps, status

### 5.4 Monitoring and Tracing (MVP)

- Structured JSON logs with `run-id`, `item-id`, `state`, `tool`, `duration-ms`
- Correlation ids propagated from CLI/server entrypoints
- Basic counters in logs (processed, skipped, retried, failed)
- Metrics endpoint and full tracing are post-MVP enhancements

---

## 6. CLI Commands

```
machinum
├── install [tool...]                    # Install tools from tools.yaml
│   ├── download                         # Fetch tools from source registries
│   └── bootstrap                        # Run installation scripts for opted-in tools
├── run [pipeline-name]                  # Execute pipeline
│   ├── --resume <run-id>                # Resume from checkpoint
│   └── --dry-run                        # Validate without executing
├── cleanup                              # Clearing intermediate files/logs/runs etc, e.g.
│   ├── --run-id <run-id>                # Clean specific run
│   └── --older-than <duration>          # Clean for given time interval
├── serve                                # Start HTTP server
│   ├── --port 8080                      # Server port
│   └── --ui                             # Enable admin UI
├── mcp                                  # MCP mode
│   ├── --command                        # No daemon mode
│   └── --server                         # Server mode
├── status                               # Show app status
│   └── --run-id <run-id>                # Show execution status
├── logs                                 # Show app logs
│   └── --run-id <run-id>                # Show execution logs
└── help                                 # Display help
```

---

## 7. Checkpointing & State Management

### 7.1 State File Structure (`.mt/state/{run-id}/checkpoint.json`)

//TODO: add somewhere, that on run we need to backup pipeline yaml to work with specific version of it(default behaivour)
//TODO: add some config key to pipeline yaml, that we must work with actual copy and do not make backups for it
//TODO: add here info about runner. For StepOver we need to know where we stop execution to prolong next

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
      "metadata": {
        "title": "Introduction",
        "page": 1
      },
      "results": {
        "summary": "...",
        "embedding": [...]
      },
      "error": null
    },
    {
      "id": "chapter-02",
      "state": "TRANSLATE",
      "progress": 45,
      "metadata": {...},
      "results": {...}
    }
  ],
  "context": {
    "variables": {...},
    "batch-buffer": [...]
  }
}
```

Large runs SHOULD keep item payload in `.mt/state/{run-id}/items.json` and use `checkpoint.json` as an index/summary.

Suggested cleanup policy defaults in root config:
- Keep successful run state for 7 days
- Keep failed run state for 30 days
- Keep latest N successful runs per pipeline (default 5)
- Provide manual cleanup command: `machinum cleanup --run-id <id>|--older-than <duration>`

### 7.2 Checkpoint Strategy

- **After each item state transition:** Save item progress
- **After batch/window completion:** Save batch results
- **On interrupt (SIGTERM):** Save full state
- **Resume:** Load checkpoint, skip completed items/states

---

## 8. Admin UI (Read-Only)

### 8.1 Routes (Jooby)

Write/action endpoints are post-MVP and intentionally excluded from initial read-only admin UI.

```
GET  /                        → Dashboard (running pipelines)
GET  /pipelines               → List available pipelines
GET  /pipelines/{name}        → Pipeline definition
GET  /runs                    → List executions
GET  /runs/{run-id}           → Execution details
GET  /runs/{run-id}/items     → Items with status
GET  /runs/{run-id}/logs      → Tail logs
GET  /tools                   → Installed tools
GET  /health                  → Health check
```

### 8.2 UI Features

Tool-provided custom web components are post-MVP and will be introduced after the base admin UI stabilizes.

- Real-time status via SSE (`/runs/{run-id}/stream`)
- Pipeline visualization (state graph)
- Item progress bars
- Log viewer with filtering
- Tool registry browser

---

## 9. Execution Models

### 9.1 Sequential Execution

//TODO: add info that it's a part of OneStep runner, other runners must reuse OneStep and change part with elemntes loading

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

//TODO: Under hood we always must relly on async execution. For mvp OneStep must start only one thread/CompletableFuture

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

| Strategy   | Behavior                               |
|------------|----------------------------------------|
| `stop`     | Abort entire pipeline, save checkpoint |
| `skip`     | Skip current item, continue with next  |
| `retry`    | Retry current tool with backoff        |
| `fallback` | Use fallback tool/value                |

### 10.2 Exception Classification

```java
public class ErrorHandler {
    public ErrorStrategy determineStrategy(Exception e, ErrorHandlingConfig config) {
        // Match exception type against configured strategies
        // Apply default if no match
    }
    
    public void handle(ExecutionContext ctx, Exception e, ErrorStrategy strategy) {
        switch (strategy) {
            case RETRY -> scheduleRetry(ctx);
            case SKIP -> markItemSkipped(ctx);
            case STOP -> shutdownAndCheckpoint(ctx);
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
        // Parse {{ ... }} syntax, e.g. just use regex and replace to ${}
        // Extract Groovy expression
        // Bind variables: item, context, metadata, previous, env, scripts
        // Return result
    }
    
    public Object evaluateFile(Path scriptPath, ExecutionContext ctx) {
        // Load .groovy file, evaluate with same binding
    }
}
```

### 11.2 Available Bindings

//TODO: enrich next table with info from above(`4.4 Pipeline Declaration YAML`)

| Variable   | Description                  |
|------------|------------------------------|
| `item`     | Current item being processed |
| `context`  | Pipeline execution context   |
| `metadata` | Pipeline metadata            |
| `previous` | Output from previous tool    |
| `env`      | Environment variables        |
| `scripts`  | External script loader       |

---

## 12. Project Structure (Gradle)

The module split below is target architecture. During bootstrap phase, docs may lead implementation.
```
machinum-pipeline/
├── build.gradle
├── settings.gradle
├── README.md
├── docs/
│   └── tdd.md
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
│   ├── src/main/resources/
│   │   └── webapp/
│   └── src/test/java/
├── tools/                               # Tool SDK and built-in tool adapters (planned)
#TODO: add here subfolder with coomon module and several internal tools
├── ui/                                  # Planned
│   ├── admin-ui/
│   ├── vscode-extension/
│   └── shared-components/
└── mcp/
    └── src/main/java/machinum/mcp/
```

---

## 13. Build Configuration (build.gradle)

More info can be found here [build-configuration.md](build-configuration.md)

---

## 14. Roadmap & Phases

### Phase 1: Core Foundation (MVP)
- YAML loading with unified `body` manifests
- Tool registry with internal tool support
- Sequential state machine execution
- Basic CLI (`run`, `help`, `status`, `logs`)
- Simple checkpointing with optional `items.json` split
- Logging infrastructure
- `.env/.ENV` based runtime environment loading

### Phase 2: External Tools & Caching
- Shell-based external tool execution
- Tool source resolution (git, HTTP, file)
- Tool caching and versioning
- `install` command with `download` and `bootstrap` actions
- Cleanup policies and `cleanup` command

### Phase 3: Advanced Pipeline Features
- Parallel execution (per-item)
- Windowing and aggregation
- Fork/sub-pipeline support
- Full checkpoint/resume
- Groovy scripting with external scripts
- Docker tool execution (experimental -> stable)

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
| **Scalability**   | Support 10,000+ items per pipeline                    |
| **Reliability**   | Checkpoint every 30s, resume within 1 minute          |
| **Observability** | Structured logging, trace IDs, metrics endpoint       |
| **Security**      | Docker isolation, no root required, config validation |
| **Compatibility** | Java 25, Linux/macOS primary, Windows secondary       |

---

## 16. Open Items & Future Considerations

1. **State store backend:** Start with filesystem, evaluate Redis for distributed
2. **Pipeline composition:** Reference sub-pipelines from other YAMLs
3. **Metrics:** Prometheus integration
4. **Authentication:** For server mode (admin UI)
5. **Tool SDK:** Provide Java annotations for easier internal tool development
6. **Webhook triggers:** Start pipelines from external events
7. **Action endpoints:** Controlled run actions from admin UI/API (post read-only MVP)
8. **Fork execution DSL:** Clear syntax for sub-pipeline orchestration

---

**Document Version:** 1.2  
**Last Updated:** 2026-03-24
**Status:** Approved for Phase 1 Development
