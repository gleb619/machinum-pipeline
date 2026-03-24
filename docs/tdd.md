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

//TODO add here vite/vitetest/cypress

| Component       | Technology      | Version          |
|-----------------|-----------------|------------------|
| Build System    | Gradle          | 8.x (Groovy DSL) |
| Language        | Java            | 25               |
| Web Framework   | Jooby           | 4.1              |
| CLI Library     | Picocli         | 4.7+             |
| Configuration   | SnakeYAML       | 2.0+             |
| Scripting       | Groovy          | 4.0+             |
| Logging         | SLF4J + Logback | 2.x              |
| JSON Processing | Jackson         | 2.17+            |
| Docker Client   | docker-java     | 3.4+             |
| Web UI          | Vue             | Modern           |

---

## 3. Directory Structure

//TODO: enrich next project structure, add there a package.json and folders src/main, src/test
        desired folder strucutre must be created by some tool on install. package.json creation also depends on some 
        other tool

//TODO: Add special cli command for script creation
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
└─── output/                           # Processed results
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

//TODO add body fied, redo all manifest, we need all of them have same header(e.g. version, type, etc, e.g.) and 
  different body

```

### 4.2 Root Pipeline YAML (`mt-pipeline.yaml`)

```yaml
version: 1.0.0
type: root
name: "Book Processing Pipeline"
description: "Process book chapters through AI pipeline"

//TODO Exclude source/items from root yaml, we need to move it to pipeline yaml instead
# Source definition
source:
  type: filesystem|s3|http
  location: "./input/book.pdf"
  format: pdf|md|docx
  loader: "{{scripts/loaders/pdf-loader.groovy}}"

# Items definition (what gets processed)
items:
  type: chapter|document|page|script
  script-extractor: "{{scripts/extractors/chapter-extractor.groovy}}"
  metadata:
    book_id: "{{metadata.book_id}}"
    title: "{{extracted.title}}"

# Pipeline reference
//TODO, remove this part, we need to control which pipeline to launch based on cli command `run`
pipeline:
  name: "complex-pipeline"
  version: "1.0.0"

//TODO: instead add link to tools.yaml

# Execution configuration
execution:
  parallel: true
  max_concurrency: 4
  resume: true                     # Enable checkpointing
  error_strategy: stop|skip|retry
  max_retries: 3
  retry_delay: 5s

//TODO change it, we need to add work with: `.env|.ENV` files instead to handle security
# Environment variables
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

//TODO START
  add here installation config, e.g. this file provide info about tools itself, and allow to execute them 
  with 
  some cli command. For example we could have a 'git-tool' that create git repository in configured folder. And we 
  need something like `install` subcommand, that execute tools with correspondent configuration. Not all tools will 
  have such, only several. So we have tools that will be used only on bootstrap, tools for runtime, and some hybrid ones
//TODO END

tools:
  - name: qwen-summary
    type: internal|external
    version: 2.1.0
    source:
      type: git|http|file|spi
      url: "https://github.com/org/qwen-summary.git"
      tag: v2.1.0
    cache: true
    timeout: 30s
    retry: 2
    config:
      model: qwen2.5-72b
      temperature: 0.7
    input_schema:  # JSON schema for validation of external data only
      type: object
      properties:
        text: { type: string }
    output_schema:
      type: object
      properties:
        summary: { type: string }

  - name: embedding-generator
    type: external
    runtime: docker
    source:
      type: http
      url: "https://registry.example.com/embedding:latest"
    cache: true
    config:
      model: bge-large
      dimension: 1024

  - name: glossary-consolidator
    type: internal
    class: machinum.tools.GlossaryConsolidator
    source:
      type: spi
    config:
      threshold: 0.8

  - name: md-formatter
    type: external
    runtime: shell
    source:
      type: file
      url: "/app/some-path/script.sh"
    cache: false
    config:
      work_dir: {{rootDir}}
```

### 4.4 Pipeline Declaration YAML (`.mt/pipeline.yaml`)

```yaml
version: 1.0.0
type: pipeline
name: "complex-pipeline"
description: "Full AI pipeline with embeddings and translation"

# Context definition
//TODO: move that part to corresponent place in body config
context:
  variables:
    batch_size: 10
    cooldown: 5s
    allow_override_mode: false

//TODO START
Add here work with source/items stuff. We need 3 types of operations:
  1. Sources - a creation stage, where we declare where to take info. It could be collection, a file, a link, etc, .
     e.g it must be converted to suitable type via some tool
  2. Intermediate Operations - a processing, where we can do something with content. We need to improve current 
     structure to better one. To Support tool call not only with stage. But with tool chain too. And also we need 
     support of windows for item processing - for batches. And add simplified declaration with minimal info, only 
     tool name
  3. Terminal Operations - a consumers for final result. On start lets add some logger terminator that just add 
     summary to logs

  Also add tool registry here, we could have 3 types: http|git|file, 3 of them just read some yaml file where we 
  store info about tools version. By default it will be yaml file somewhere in sources of current project.
//TODO END

# State definitions (ordered)
states:
  - name: SUMMARY
    condition: "{{ item.type != 'preface' }}"  # Inline Groovy
    tools:
      - tool: qwen-summary
        input: "{{item.content}}"
        output_key: summary
      - tool: glossary-consolidator
        input: "{{previous.summary}}"
        output_key: consolidated_summary

  - name: CLEANING
    condition: "{{ scripts.conditions.should_clean(item) }}"  # External script
    tools:
      - tool: text-cleaner
        input: "{{item.content}}"
        output_key: cleaned_text

  - name: EMBEDDING
    tools:
      //TODO: add simplified declaration here
      - tool: embedding-generator
        input: "{{cleaned_text}}"
        output_key: embedding

  - name: GLOSSARY
    tools:
      - tool: glossary-extractor
        input: "{{cleaned_text}}"
        //TODO: output_key needed only if we have more that one tools in chain. By default output_key is toolname 
        output_key: glossary 
      - tool: glossary-consolidator
        input: "{{glossary}}"
        output_key: consolidated_glossary

  - name: GLOSSARY_CONSOLIDATION
    condition: "{{ consolidated_glossary.size() > 0 }}"
    tools:
      - tool: glossary-deduplicator
        input: "{{consolidated_glossary}}"
        output_key: final_glossary

  - name: TRANSLATE_TITLE
    window:
      type: tumbling
      size: "{{context.batch_size}}"
      //TODO: make this part more expressive
      aggregation:
        key: title
        tool: batch-translator
        output_key: translated_titles

  - name: TRANSLATE
    tools:
      - tool: translator
        input:
          text: "{{cleaned_text}}"
          glossary: "{{final_glossary}}"
        output_key: translated_text

  - name: COPYEDIT
    tools:
      - tool: grammar-editor
        input: "{{translated_text}}"
        output_key: final_text

  //TODO: add here call of fork
  - name: SYNTHESIZE
    condition: "{{item.generate_audio == true}}"
    tools:
      - tool: tts-generator
        input: "{{final_text}}"
        output_key: audio_url

  - name: FINISHED
    wait_for: "{{context.cooldown}}"
    //TODO move that part to different level instead for termination operation
    finalize:
      - save: "{{output/final/{{item.id}}.json}}"
      - notify: "{{scripts/notifications/complete.groovy}}"

# Error handling (global)
error_handling:
  default_strategy: retry
  retry_config:
    max_attempts: 3
    backoff: exponential
  strategies:
    - exception: "TimeoutException"
      strategy: retry
    - exception: "ValidationException"
      strategy: skip
    - exception: ".*"
      strategy: stop

# Parallel execution
parallel:
  enabled: true
  max_forks: 4
  //TODO: make that part simplier, move configuration of work to pipe instead. And add config field for each 
          `pipelines` to configure such behaiviour
  fork_groups:
    - name: embedding-group
      states: [EMBEDDING, GLOSSARY]
      strategy: parallel
    - name: translation-group
      states: [TRANSLATE, COPYEDIT]
      strategy: sequential
```

---

## 5. Core Architecture

### 5.1 High-Level Components

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
public abstract class InternalTool implements Tool {
    public abstract JsonNode process(JsonNode input, ToolContext context);
}

//TODO add ExternalTool here

// External Tool (Shell)
public class ShellTool extends ExternalTool {
    public JsonNode execute(JsonNode input, ToolContext context) {
        // Use process builder here
    }
}
//TODO: mark Docker as experemental, and say that it will be done only in latest releases, not on start
// External Tool (Docker)
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
    //TODO add here listeners and interceptors
    
    public Flow<T> createFlow(List<T> items, PipelineContext context);
}

// Execution Context
public class ExecutionContext {
    private final String runId;
    private final Map<String, Object> metadata;
    private final Map<String, Object> variables;
    private final GroovyEvaluator groovy;//TODO remove Evaluator from here, we need another way for interpolation, 
                                                maybe some bean, or else, etc, e.g.
    
    public Object evaluate(String expression);  // {{ ... }} support
}

//TODO: add here other interfaces/abstract classes, without implementation, only to fixate them in document
```

//TODO: add new section here, we need base models, like: source, item, line

//TODO: add here monitoring/tracing description
---

## 6. CLI Commands

```
machinum
├── install [tool...]                    # Install tools from tools.yaml
│   ├── TODO we need action for download
│   └── TODO we need action for run instalation scripts/tools
├── run [pipeline-name]                  # Execute pipeline
│   ├── --resume <run-id>                # Resume from checkpoint
│   ├── --parallel                       # Enable parallel execution
│   └── --dry-run                        # Validate without executing
├── serve                                # Start HTTP server
│   ├── --port 8080                      # Server port
│   └── --ui                             # Enable admin UI
├── mcp                                  # MCP mode
│   ├── --command                        # no daemon mode
│   └── --server                         # server mode
├── status [run-id]                      # Show pipeline status
├── logs [run-id]                        # Show execution logs
└── help                                 # Display help
```

---

## 7. Checkpointing & State Management

### 7.1 State File Structure (`.mt/state/{run-id}/checkpoint.json`)

```json
{
  "run_id": "20250321-abc123",
  "pipeline": "complex-pipeline",
  "started_at": "2025-03-21T10:00:00Z",
  "last_updated": "2025-03-21T10:15:30Z",
  "status": "running",
  
  //TODO: split file, add here support of `items.json`
  
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
    "batch_buffer": [...]
  }
}
```

//TODO: add here some policies for clean up(and correspondent settings in root.yml with defaults). Run could take 
many hdd space, so we need to clean them manually/automatically

### 7.2 Checkpoint Strategy

- **After each item state transition:** Save item progress
- **After batch/window completion:** Save batch results
- **On interrupt (SIGTERM):** Save full state
- **Resume:** Load checkpoint, skip completed items/states

---

## 8. Admin UI (Read-Only)

### 8.1 Routes (Jooby)

//TODO: add another endpoints, not only to view, but run some actions too
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

//TODO: add another feature, some of tools must have their own ui web components, that must be used in admin ui. For 
example embedding tool must provide simple ui for search, etc. e.g. 

- Real-time status via SSE (`/runs/{run-id}/stream`)
- Pipeline visualization (state graph)
- Item progress bars
- Log viewer with filtering
- Tool registry browser

---

## 9. Execution Models

### 9.1 Sequential Execution
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
    sub_pipeline: embedding-pipeline.yaml
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

//TODO: add here module for tools, and add folder for ui with at least 3 subfolders for admin-ui,vscode-extension,
        common part for reuse between 2 moduels and tools web-components
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
└── mcp/
    └── src/main/java/machinum/mcp/
```

---

## 13. Build Configuration (build.gradle)

//TODO: add there some other plugins, like spotless/openrewrite. And add to project a toml with versions for libs
```Groovy
plugins {
    java
    application
    id("com.github.johnrengelman.shadow") version "8.1.1"
    id 'com.adarshr.test-logger' version '4.0.0' apply false
}

group = "machinum"
version = "1.0.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

//TODO omit all versions, use bom/toml instead
dependencies {
    // Jooby
    implementation("io.jooby:jooby:4.1.0")
    implementation("io.jooby:jooby-netty:4.1.0")
    implementation("io.jooby:jooby-jackson:4.1.0")
    
    // CLI
    implementation("info.picocli:picocli:4.7.6")
    
    // YAML
    implementation("org.yaml:snakeyaml:2.2")
    
    // Groovy
    implementation("org.apache.groovy:groovy:4.0.21")
    implementation("org.apache.groovy:groovy-jsr223:4.0.21")
    
    // JSON
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.0")
    implementation("com.fasterxml.jackson.dataformat:jackson-dataformat-yaml:2.17.0")
    
    // Docker
    implementation("com.github.docker-java:docker-java-core:3.4.0")
    implementation("com.github.docker-java:docker-java-transport-httpclient5:3.4.0")
    
    // Logging
    implementation("ch.qos.logback:logback-classic:1.5.3")
    implementation("org.slf4j:slf4j-api:2.0.12")
    
    // Utilities
    implementation("org.apache.commons:commons-lang3:3.14.0")
    implementation("commons-io:commons-io:2.15.1")
    
    // Testing
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.assertj:assertj-core:3.25.3")
    testImplementation("org.mockito:mockito-core:5.11.0")
}

application {
    mainClass = "machinum.cli.MachinumCli"
}

tasks.withType<Test> {
    useJUnitPlatform()
}
```

---

## 14. Roadmap & Phases

//TODO: enrich roadmap with new tasks

### Phase 1: Core Foundation (MVP)
- YAML loading with common base structure
- Tool registry with internal tool support
- Sequential state machine execution
- Basic CLI (`run`, `help`)
- Simple checkpointing (per-item)
- Logging infrastructure

### Phase 2: External Tools & Caching
- Docker tool execution
- Tool source resolution (git, HTTP, file)
- Tool caching and versioning
- `install` command and subcommands

### Phase 3: Advanced Pipeline Features
- Parallel execution (per-item)
- Windowing and aggregation
- Fork/sub-pipeline support
- Full checkpoint/resume
- Groovy scripting with external scripts

### Phase 4: Server & UI
- Jooby server implementation
- Admin UI
- SSE for real-time updates
- MCP server mode
- Interactive CLI mode

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

---

**Document Version:** 1.1  
**Last Updated:** 2025-03-24
**Status:** Approved for Phase 1 Development