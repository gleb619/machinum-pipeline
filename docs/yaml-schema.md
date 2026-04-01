# YAML Schema Design: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Common Base Structure

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
body: { }                      # Type-specific payload
```

---

## 2. Root Pipeline YAML (`root.yml`)

```yaml
version: 1.0.0
type: root
name: "Book Processing Runtime Config"
description: "Global runtime defaults and references"
labels:
  my-label: 123abc
body:
  variables:
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

---

## 3. Tools YAML (`.mt/tools.yaml`)

> **Related:** [CLI Commands §install](cli-commands.md#install), [Technical Design §3.2](technical-design.md#32-core-interfaces), [Project Structure §1](project-structure.md#1-workspace-directory-structure)

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
description: "AI and utility tools"
metadata:
  created: 2020.01.01
body:
  # Tool registry configuration (optional)
  registry:
    type: builtin              # file|http|builtin
    url: https://raw.githubusercontent.com/gleb619/machinum-pipeline/refs/heads/main/tools.yaml
    refresh: on_startup        # on_startup|never

  # Bootstrap tools list - tools to initialize during setup phase
  bootstrap:
    - prettier
    - eslint
    - workspace-init

  # Custom tool registry (flat list)
  tools:
    # Simple tool declaration - name resolves via SPI
    - name: qwen-summary
      description: "Qwen-based text summarization"
      config:
        model: qwen2.5-72b
        temperature: 0.7

    # Shell script tool
    - name: md-formatter
      description: "Markdown formatter"
      config:
        args:
          - "{{item.id}}"
        work-dir: "{{rootDir}}"

    # Groovy script tool
    - name: text-validator
      description: "Validates text content"
      config:
        script: "./.mt/scripts/validate.groovy"

    # Git tool - initializes repo and creates commits
    - name: git
      description: "Git repository management"
```

### 3.1 Tool Lifecycle

Each tool has an bootstrap lifecycle method:

| Method                        | Phase                     | Description                                                          |
|-------------------------------|---------------------------|----------------------------------------------------------------------|
| `bootstrap(ExecutionContext)` | Bootstrap (unconditional) | Runs during `machinum setup`; sets up dependencies, validates config |
| `execute(ExecutionContext)`   | Runtime (conditional)     | Runs during pipeline execution when tool is invoked                  |

**Example:**
```java
public class QwenSummary implements Tool {
    @Override
    public void bootstrap(ExecutionContext context) throws Exception {
        // Downloads model, validates API keys, initializes cache
    }

    @Override
    public ToolResult execute(ExecutionContext context) {
        // Processes input text and returns summary
    }
}
```

See [Tool Interface](technical-design.md#32-core-interfaces) for full contract details.

### 3.2 Typed Manifest Records (Tools)

The tools `body` fields are deserialized into typed Java records in `machinum.manifest`. Each YAML section maps to a record:

| YAML Section              | Java Record                | File                                                                       |
|---------------------------|----------------------------|----------------------------------------------------------------------------|
| `body`                    | `ToolsBody`                | [`ToolsBody.java`](../core/src/main/java/machinum/manifest/ToolsBody.java) |
| `body.registry`           | `ToolRegistryManifest`     | inner class of `ToolsBody`                                                 |
| `body.bootstrap[]`        | `List<String>`             | Bootstrap tool names list                                                  |
| `body.tools[]`            | `ToolDefinitionManifest`   | inner class of `ToolsBody`                                                 |
| `tool.config`             | `ToolConfigManifest`       | inner class of `ToolsBody`                                                 |

**Schema Changes (v2.1):**
- **Removed:** `execution-targets` - Execution targets removed; tools execute locally
- **Removed:** `execution-target` from tool definitions
- **Added:** `bootstrap` - List of tool names to bootstrap during setup phase

**Removed Fields:** The following fields have been removed from the tool manifest:
- `version` - Tools are versioned externally via JAR files
- `source` - Tool source resolution handled by registry type
- `cache` - Caching handled by registry implementation
- `timeout` - Timeout configured per tool implementation
- `runtime` - Runtime type inferred from tool implementation
- `execution-target` - All tools execute locally

**Compiled Model:** `ToolsManifest` → `ToolsManifestCompiler` → [`ToolsDefinition`](../core/src/main/java/machinum/definition/ToolsDefinition.java). See [Core Architecture §1.5](core-architecture.md#15-compiled-models).

---

## 4. Pipeline Declaration YAML (`src/main/manifests/pipeline.yaml`)

> **Constraint:** Exactly one of `source` or `items` must be declared; missing both throws an exception.

### 4.x `source` vs `items` — Data Acquisition Layer

The pipeline manifest accepts **exactly one** of two mutually exclusive data acquisition modes:

| Mode     | Purpose                                                                                                     | Typical Use                                                                                                |
|----------|-------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `source` | **Preprocessor** — acquires raw data from external locations and converts it into pipeline-compatible items | FTP extraction, archive decompression, HTTP download, S3 fetch, git clone, or any custom acquisition logic |
| `items`  | **Direct collection** — references items already available in the workspace as POJOs/chapters               | Pre-downloaded chapters, local JSON/JSONL files, workspace-resident documents                              |

**When to use `source`:**
Use a preprocessor when data must be fetched, extracted, or transformed before the pipeline can consume it. The `source` block defines *where* and *how* to acquire items — file paths, URLs, archives, or custom loader scripts that convert external formats (PDF, DOCX, remote APIs) into the pipeline's internal item representation.

**When to use `items`:**
Use direct items when your data already exists in the expected format within the workspace. No acquisition step is needed — the pipeline reads items directly from `src/main/chapters/` or similar locations.

**Flow:**
```
source (preprocessor) → [acquire + convert] → items → [pipeline states]
items (direct)         →                    → items → [pipeline states]
```

Both modes converge to the same item processing pipeline; only the acquisition front differs.

See [Core Architecture §1](core-architecture.md#1-base-models-mvp) for model mapping (`SourceRef` → `source`, `Item` → items processed by states).

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
      manifest-snapshot:
        enabled: true
      mode: sequential           # sequential|parallel
      max-concurrency: 4
      runner:
        type: one_step           # one_step|batch_step|batch_step_over
        batch-size: "{{config.batch-size}}"
        step_over_cursor_key: "{{run.cursor.state_item_index}}"
      listeners:
        - name: run-log-listener
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
    variables:
      book_source: "{{variables.book_id}}"
      title: "{{extracted.title}}"

  items:
    type: chapter                # chapter|paragraph|line|document|page (document|page: post-MVP)
    path: "src/main/chapters"   # Path to directory containing item files
    custom-extractor: "{{scripts/extractors/chapter-extractor.groovy}}"
    variables:
      book_id: "{{variables.book_id}}"
      title: "{{extracted.title}}"

  # State definitions (ordered)
  states:
    # Async tools run concurrently; next sequential tool auto-waits for all prior async completions
    - name: PREPROCESS
      tools:
        - tool: language-detector
          async: true
          output: detected_lang
        - tool: text-normalizer
          async: true
          output: normalized
        - tool: content-validator
          input:
            lang: "{{detected_lang}}"
            text: "{{normalized}}"

    - name: SUMMARY
      condition: "{{ item.type != 'preface' }}"
      tools:
        - tool: qwen-summary
          input: "{{item.content}}"
          output: summary
        - tool: glossary-consolidator
          input: "{{previous.summary}}"
          output: consolidated_summary

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
                    output: embedding
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
          output: final_glossary

    - name: TRANSLATE_TITLE
      window:
        type: tumbling
        size: "{{config.batch-size}}"
        aggregation:
          group-by: title
          tools:
            - batch-translator
          output: translated_titles

    - name: TRANSLATE
      tools:
        - tool: peek
          tools:                   # Tool chain; output receives last tool's result
            - tool: language-detector
            - tool: translator-guard
            - tool: translator
              input:
                text: "{{cleaned_text}}"
                glossary: "{{final_glossary}}"
          output: translated_text

    - name: COPYEDIT
      tools:
        - tool: grammar-editor
          input: "{{translated_text}}"
          output: final_text

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

### 4.1 Typed Manifest Records (Pipeline)

The pipeline `body` fields are deserialized into typed Java records in `machinum.manifest`. Each YAML section maps to a record:

| YAML Section  | Java Record              | File                                                                                                                              |
|---------------|--------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `body`        | `PipelineBody`           | [`core/src/main/java/machinum/manifest/PipelineBody.java`](../core/src/main/java/machinum/manifest/PipelineBody.java)             |
| `body.config` | `PipelineConfigManifest` | [`core/src/main/java/machinum/manifest/PipelineConfigManifest.java`](../core/src/main/java/machinum/manifest/PipelineConfig.java) |
| `body.source` | `SourceManifest`         | [`core/src/main/java/machinum/manifest/SourceManifest.java`](../core/src/main/java/machinum/manifest/SourceConfig.java)           |
| `body.items`  | `ItemsManifest`          | [`core/src/main/java/machinum/manifest/ItemsManifest.java`](../core/src/main/java/machinum/manifest/ItemsConfig.java)             |

### 4.2 Typed Manifest Records (Root)

The root `body` fields are deserialized into typed Java records in `machinum.manifest`. Each YAML section maps to a record:

| YAML Section                         | Java Record                  | File                                                                                                                                              |
|--------------------------------------|------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `body`                               | `RootBody`                   | [`core/src/main/java/machinum/manifest/RootBody.java`](../core/src/main/java/machinum/manifest/RootBody.java)                                     |

**Compilation path:** `PipelineBody` (typed manifest) → `PipelineManifestCompiler` → `PipelineDefinition` (compiled). See [Technical Design §3.3](technical-design.md#33-value-compilation-system).

**Tool declaration rules:**

- Shorthand: `- tool-name`
- Object form: `- tool: tool-name`
- `output` defaults to tool name if omitted
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

## 5. Runtime Compilation

> **Note:** All string values supporting `{{...}}` expressions are compiled to `CompiledValue<T>` at load time. See [Value Compilers](value-compilers.md) for details.

**Compilation Process:**
1. YAML loaded → Raw POJO (e.g., `ToolDefinition`)
2. Compiler transforms → Compiled POJO (e.g., `CompiledToolDefinition`)
3. String fields → `CompiledValue<String>` wrappers
4. Map fields → `CompiledMap` wrappers
5. At runtime: `CompiledValue.get()` evaluates Groovy expression

**Example:**
```yaml
# YAML
condition: "{{ item.size() > 0 }}"
tools:
  - tool: "{{env.DEFAULT_TOOL}}"
```

```java
// Compiled
CompiledStateDefinition state = compiler.compile(rawState, ctx);
boolean shouldRun = state.evaluateCondition();  // Evaluates: item.size() > 0
String toolName = state.getStateTools().get(0).getNameValue();  // Evaluates: {{env.DEFAULT_TOOL}}
```
