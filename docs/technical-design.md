# Technical Design Document: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Project Overview

**Project Name:** machinum-pipeline

**Purpose:** A pluggable document processing orchestration engine that manages stateful pipelines with tool composition,
checkpointing, and hybrid execution modes.

**Core Capabilities:**

- Process items (chapters, documents, files) through state machine–defined pipelines (see [YAML Schema §4.x](yaml-schema.md#4x-source-vs-items--data-acquisition-layer) for data acquisition modes)
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

## 3. Core Architecture

### 3.1 High-Level Components

The orchestration layer centers on a pluggable runner and event pipeline:

- **Runner subsystem:** selects `one_step`, `batch_step`, or `batch_step_over`; controls item/state iteration strategy
- **Listener chain:** receives lifecycle events (`run_start`, `state_start`, `state_success`, `state_failure`,
  `run_complete`)
- **Interceptor chain:** executes around state transitions for validation, metrics, tracing, and policy checks
- **Error handling subsystem:** resolves strategy from merged root/pipeline config; applies retry/skip/stop/fallback
- **Execution target abstraction:** tools execute against local, SSH, or Docker targets via a unified executor contract

```
graph TD
    subgraph CLI_Server_Layer ["CLI / Server Layer"]
        Install["install"]
        Run["run"]
        Serve["serve"]
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

### 3.2 Core Interfaces

See [Value Compilers](value-compilers.md) for the complete compiler system documentation.

```java
// Tool Contract
public interface Tool {
    ToolDefinition definition();
    ToolResult execute(ExecutionContext context) throws Exception;
    default void validate() {}
    
    record ToolResult(boolean success, Map<String, Object> outputs, String errorMessage) {}
}

// Internal Tool (Java SPI) - with lifecycle methods
public interface InternalTool extends Tool {
    /**
     * Install lifecycle method - executes unconditionally during install phase.
     * Use for: downloading dependencies, initializing state, validating config.
     */
    default void bootstrap(ExecutionContext context) throws Exception {
        // No-op by default
    }
    
    /**
     * Process method - executes during pipeline runtime when tool is invoked.
     */
    ToolResult process(ExecutionContext context) throws Exception;
    
    @Override
    default ToolResult execute(ExecutionContext context) throws Exception {
        return process(context);
    }
}

// Tool Contract (unified - no internal/external separation)
public interface Tool {
    ToolInfo info();
    ToolResult execute(ExecutionContext context) throws Exception;

    /**
     * Bootstrap lifecycle method - executes for explicitly defined tools during bootstrap phase.
     */
    default void bootstrap(BootstrapContext context) throws Exception {
        // No-op by default
    }

    /**
     * Executed strictly after bootstrap for all ordered tools in separate AFTER_BOOTSTRAP phase.
     * Use for post-creation operations that might affect compilation.
     */
    default void afterBootstrap(BootstrapContext context) throws Exception {
        // No-op by default
    }

    default List<String> dependsOn() { return List.of(); }
    default int priority() { return -1; }
    default void validate() {}

    record ToolResult(boolean success, Map<String, Object> outputs, String errorMessage) {}
}

// Tool Registry Types
public interface ToolRegistry {
    void register(Tool tool);
    Optional<Tool> resolve(String name);
}

/**
 * Registry URI Parsing:
 * - URI: classpath://, file://, http://, https://
 *
 * Configuration in tools.yaml:
 * ```yaml
 * body:
 *   registry: classpath://default        # URI format
 *   registry: file:///path/to/tools      # local file path
 *   registry: https://.../tools.yaml     # remote HTTP registry (always refreshed)
 * ```
 */

// Shared Base Jar Registry - handles classloading & SPI tool discovery
public abstract class AbstractJarToolRegistry implements ToolRegistry {
    // Maintains URLClassLoaders for loaded jars
    // Discovers tools via ServiceLoader.load(Tool.class)
    // Ensures context ClassLoader is set during execution phase
}

// Built-in Tool Registry - local dev, loads from classpath or Gradle build output
// See: docs/core-architecture.md#52-built-in-tool-registry
// See: docs/project-structure.md#31-built-in-mode-gradle-configuration
public class BuiltInToolRegistry extends AbstractJarToolRegistry {
    // Phase 1: ServiceLoader from classpath (when -PbuiltinToolsEnabled=true)
    // Phase 2: Scan tools/{internal,external}/build/libs/*.jar (fallback)
    // Supports module filtering (internal, external)
}

// File Tool Registry - offline prod, loads jars from path
public class FileToolRegistry extends AbstractJarToolRegistry {
    // Loads tools directly from provided path (e.g. .mt/tools cache directory)
}

// HTTP Tool Registry - online prod, downloads tools from remote URLs
public class HttpToolRegistry implements ToolRegistry {
    // Downloads tools from GitHub/HTTP URLs to cache directory
    // Delegates actual registration and loading phase to FileToolRegistry instance
}

// Tool Registrar - generates registry manifests
public class ToolRegistrar {
    // Scans for tools via SPI
    // Generates registry-manifest.json with tool metadata
    // Used by FileToolRegistry to load tools without compilation
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

// Execution Context (in tools:common — stays Map-based for tool compatibility)
@Data
public class ExecutionContext {
    private final String runId;
    private final Map<String, Object> metadata;
    private final Map<String, Object> variables;
    private final Map<String, Object> currentItem;  // StreamItem converted to Map at executor level

    public String getTextContent();        // reads "content" key from currentItem map
    public Object evaluate(String expression); // resolves {{ ... }}
}

// Streamer — observer-style item producer with lifecycle callbacks
public sealed interface Streamer permits ItemsStreamer, SourceStreamer {
    // Synchronous (deprecated)
    @Deprecated
    List<StreamItem> stream(Path workspaceDir);

    // Observer-style with batch support and resume
    void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback);

    // Error-tolerant — connection/IO errors don't break the flow
    void stream(Path workspaceDir, StreamCursor cursor,
        StreamerCallback callback, Consumer<StreamError> errorHandler);
}

// Stream lifecycle callback interface
public interface StreamerCallback {
    // Called for each batch of items (return false to stop streaming)
    boolean onBatch(List<StreamItem> items, StreamCursor cursor);
    
    // Called once when streaming begins
    default void onStreamStart(StreamCursor initialCursor) {}
    
    // Called once when streaming completes (normal or explicit stop)
    default void onStreamEnd(StreamCursor finalCursor) {}
}

// Typed item replacing raw Map<String, Object>
public record StreamItem(
    Path file, Integer index, Integer subIndex,
    String content, Map<String, Object> metadata) {}

// Resume cursor — maps to checkpoint fields (state_index, item_offset, window_id)
public record StreamCursor(int stateIndex, int itemOffset, int windowId, String runId) {}

// Non-fatal stream error — recoverable errors (CONNECTION, TIMEOUT) don't stop the stream
public record StreamError(ErrorType type, String message, Throwable cause, StreamCursor cursorAtError) {}

// Batch consumer callback
@FunctionalInterface
public interface StreamerCallback {
    boolean onBatch(List<StreamItem> items, StreamCursor cursor); // return false to stop
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

// ToolRegistry interface removed - see new registry types above

public interface ToolExecutor {
    JsonNode execute(Tool tool, JsonNode input, ToolContext context);
}

public interface CheckpointStore {
    void save(CheckpointSnapshot snapshot);
    Optional<CheckpointSnapshot> load(String runId);
}

public interface ErrorStrategyResolver {
    ErrorStrategy resolve(Exception e, FallbackConfig config);
}

// Value Compilation System
public class CompiledValue<T> implements Supplier<T> {
    public static <T> CompiledValue<T> of(String raw, ExpressionContext ctx, ExpressionResolver resolver);
    public static <T> CompiledValue<T> ofConstant(T constant);
    @Override
    public T get();  // Lazy evaluation
}

public interface YamlCompiler<SOURCE, COMPILED> {
    COMPILED compile(SOURCE source, CompilationContext ctx);
    boolean supports(Class<?> type);
}

public class CompilationContext {
    private ExpressionResolver resolver;
    private ScriptRegistry scriptRegistry;
    private Map<String, Object> variables;
    private Map<String, String> environment;
    private String runId;
}
```

---

## 3.3 Value Compilation System

The value compilation system transforms YAML manifest POJOs with raw `String` values into compiled POJOs with lazy expression evaluation support. See [Value Compilers](value-compilers.md) for complete documentation.

**Key Components:**

| Component            | Purpose                                                  |
|----------------------|----------------------------------------------------------|
| `CompiledValue<T>`   | Lazy-evaluating wrapper for expression-containing values |
| `CompilationContext` | Shared state during compilation                          |
| `YamlCompiler<S,C>`  | Base interface for all compilers                         |

**Available Compilers:**

| YAML Model         | Compiled Output            | Compiler Class             |
|--------------------|----------------------------|----------------------------|
| `ToolDefinition`   | `CompiledToolDefinition`   | `ToolDefinitionCompiler`   |
| `StateDefinition`  | `CompiledStateDefinition`  | `StateDefinitionCompiler`  |
| `PipelineManifest` | `CompiledPipelineManifest` | `PipelineManifestCompiler` |
| `RootManifest`     | `CompiledRootManifest`     | `RootManifestCompiler`     |
| `ToolsManifest`    | `CompiledToolsManifest`    | `ToolsManifestCompiler`    |

**Example:**
```java
// Load and compile pipeline
CompilationContext ctx = // ... setup
CompiledPipelineManifest pipeline = loader.loadCompiledPipelineManifest(path, ctx);

// Evaluate condition at runtime
for (CompiledStateDefinition state : pipeline.getPipelineStates()) {
    if (state.evaluateCondition()) {  // Groovy expression evaluated here
        // Process tools
    }
}
```

---

## 3.4 Stream Lifecycle Management

The streaming system supports three execution modes with lifecycle callbacks:

| Mode           | Schema      | Behavior                                    | Streamer                           |
|----------------|-------------|---------------------------------------------|------------------------------------|
| **Finite**     | `file://`   | Streams all items, then completes           | `FileSourceStreamer`, `JsonlSourceStreamer` |
| **Infinite**   | `http://`   | Runs until explicitly stopped or idle       | `HttpSourceStreamer`               |
| **Void**       | `void://`   | Immediately completes with no items         | `VoidSourceStreamer`               |

### Stream Lifecycle Callbacks

All streamers call lifecycle methods on `StreamerCallback`:

1. **`onStreamStart(cursor)`** — Called once when streaming begins
2. **`onBatch(items, cursor)`** — Called for each batch (return `false` to stop)
3. **`onStreamEnd(cursor)`** — Called once when streaming completes

### Infinite Stream Control

`HttpSourceStreamer` supports infinite streaming with automatic idle detection:
- Default idle timeout: 10 consecutive empty polls (50 seconds)
- Configurable via `MAX_IDLE_POLLS` constant
- Stops immediately when `onBatch()` returns `false`

### Void Source

Use `void://` when you need a pipeline that processes no items. Useful for:
- Testing pipeline configuration without data
- Stateful operations that don't require input
- Conditional workflows where source is optional

See [YAML Schema §4.1](yaml-schema.md#41-source-uri-schema) for URI examples.
See [VoidSourceStreamer](../core/src/main/java/machinum/streamer/VoidSourceStreamer.java) for implementation.
See [StreamerCallback](../core/src/main/java/machinum/streamer/StreamerCallback.java) for interface.

---

## 4. Execution Models

### 4.1 Sequential Execution

Base algorithm of `one_step` runner. Other runners reuse the same state transition contract and vary only in item/window
loading strategy.

```java
for (Item item: items) {
    for (State state: pipeline.getStates()) {
        if (conditionMet(item, state)) {
            processState(item, state);
            checkpoint();
        }
    }
}
```

### 4.2 Parallel Execution (Future)

All runners use async primitives internally. For MVP, `one_step` constrains `max_in_flight = 1` for deterministic
behavior.

```java
ExecutorService executor = Executors.newFixedThreadPool(maxConcurrency);
List < CompletableFuture < Void >> futures = items.stream().map(item -> CompletableFuture.runAsync(() -> processItem(item), executor)).collect(toList());
CompletableFuture.allOf(futures).join();
```

### 4.3 Fork/Sub-Pipeline (Future)

```yaml
fork:
  - name: parallel-embedding
    states: [EMBEDDING]
    mode: parallel
    sub-pipeline: embedding-pipeline.yaml
```

---

## 5. Error Handling

### 5.1 Error Strategies

| Strategy   | Behavior                               |
|------------|----------------------------------------|
| `stop`     | Abort entire pipeline, save checkpoint |
| `skip`     | Skip current item, continue with next  |
| `retry`    | Retry current tool with backoff        |
| `fallback` | Use fallback tool/value                |

### 5.2 Exception Classification

```java
public class ErrorHandler {

  public ErrorStrategy determineStrategy(Exception e, FallbackConfig config) {
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

## 6. Groovy Scripting Integration

### 6.1 Evaluation Context

For expression compilation and lazy evaluation, see [Value Compilers](value-compilers.md).

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

### 6.2 Available Bindings

| Variable           | Description                  |
|--------------------|------------------------------|
| `item`             | Current item being processed |
| `context`          | Pipeline execution context   |
| `metadata`         | Pipeline metadata            |
| `previous`         | Output from previous tool    |
| `env`              | Environment variables        |
| `scripts`          | External script loader       |
| `state`            | Current state definition     |
| `tool`             | Current tool definition      |
| `runId`            | Active run id                |
| `index`            | Current item index           |
| `text`             | Current item text/content    |
| `textWords`        | Word count                   |
| `textTokens`       | Token count (`CL100K_BASE`)  |
| `aggregationIndex` | Active window index          |
| `aggregationText`  | Window aggregation payload   |

---

## 7. Roadmap & Phases

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

## 8. Non-Functional Requirements

| Requirement       | Target                                                |
|-------------------|-------------------------------------------------------|
| **Performance**   | <100ms overhead per item (excluding tool execution)   |
| **Scalability**   | 10,000+ items per pipeline                            |
| **Reliability**   | Checkpoint every 30s; resume within 1 minute          |
| **Observability** | Structured logging, trace IDs, metrics endpoint       |
| **Security**      | Docker isolation, no root required, config validation |
| **Compatibility** | Java 25; Linux/macOS primary, Windows secondary       |

---

## 9. Open Items & Future Considerations

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
