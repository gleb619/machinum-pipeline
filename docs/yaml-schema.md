# YAML Schema Design: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

> **Examples:** See [`examples/`](../examples/) folder for working YAML configurations:
> - [`examples/empty-body-test/empty`](../examples/empty-body-test/empty) - Configuration without body field
> - [`examples/empty-body-test/minimal`](../examples/empty-body-test/minimal) - Configuration with `body: {}`
> - [`examples/empty-body-test/partial`](../examples/empty-body-test/partial) - Configuration with some data in file
> - [`examples/fully-empty-folder/`](../examples/fully-empty-folder/) - Empty folder with no manifests (defaults applied)
> - [`examples/sample-test/`](../examples/sample-test/) - Basic example with folder structure
> - [`examples/expression-test/`](../examples/expression-test/) - Basic example with {{ expression }} usage
> - [`examples/shorthand-test/`](../examples/shorthand-test/) - Basic example with short declaration form

## 1. Common Base Structure

All YAML files share this base:

```yaml
version: 1.0.0
type: pipeline|tools|root|manifest     # Discriminator
name: string
description: string                    # Optional
labels:
  key: value
metadata:
  author: string
  created: timestamp
body: { }                              # Type-specific payload (optional - defaults to empty)
```

**Note:** The `body` field is **optional**. When omitted or empty, default values are applied:
- Maps default to empty maps
- Lists default to empty lists
- Objects default to empty instances (runtime uses system defaults), not nulls

**Default Application:**

When manifests are missing entirely (empty folder), defaults are applied automatically by [`Executor.setDefaults()`](../core/src/main/java/machinum/executor/Executor.java#L72-L91):
- Missing `seed.yaml` → [`RootBody.empty()`](../core/src/main/java/machinum/manifest/RootBody.java#L34-L40)
- Missing `.mt/tools.yaml` → [`ToolsBody.empty()`](../core/src/main/java/machinum/manifest/ToolsBody.java#L36-L41)
- Missing pipeline → If name specified, then loaded on-demand during `run` command. By default, the oldest file 
  will be used(by creation date) or → [`PipelineBody.empty()`](../core/src/main/java/machinum/manifest/PipelineBody.java#L24-L33).

---

## 2. Root Pipeline YAML (`root.yml`)

### Minimal Example (Empty Body)

```yaml
version: 1.0.0
type: root
name: "Minimal Root"
# body is optional - defaults to empty values
```

### Default Values

When `body` is omitted or empty:
- `variables` → empty map
- `execution` → `empty` (runtime uses defaults: parallel=false, concurrency=4)
- `fallback` → `empty` (runtime uses default strategy)
- `config` → `empty` (runtime uses default batch sizes)
- `cleanup` → `empty` (runtime uses default retention)
- `secrets` → empty list
- `env` → empty map

Applied via [`RootBody.empty()`](../core/src/main/java/machinum/manifest/RootBody.java#L34-L40).

When `seed.yaml` is missing entirely, [`Executor.setDefaults()`](../core/src/main/java/machinum/executor/Executor.java#L72-L91) creates an empty root manifest automatically during setup.

### Full Example

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
    concurrency: 4               # default
    resume: true                 # default
    snapshot:
      mode: copy                 # copy|reference; default: copy
  fallback:
    retry:
      max: 3
      backoff:
        type: fixed              # fixed|linear|exponential; default: fixed
        start: 1s
        max: 30s
        multiplier: 2.0
        jitter: 0.15
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: "ValidationException"
        strategy: skip
      - exception: ".*"
        strategy: stop
  config:
    batch: 10
    window: 5
    cooldown: 5s
    override: false
  cleanup:
    pass: 5d
    fail: 7d
    passes: 5
    fails: 10
  secrets:
    - ".env"
    - ".ENV"
  env:
    API_KEY: "{{env.OPENAI_KEY}}"
    AWS_REGION: us-east-1
```

---

## 3. Tools YAML (`.mt/tools.yaml`)

> **Related:** [CLI Commands §install](cli-commands.md#install), [Technical Design §3.2](technical-design.md#32-core-interfaces), [Project Structure §1](project-structure.md#1-workspace-directory-structure)

### Minimal Example (Empty Body)

```yaml
version: 1.0.0
type: tools
name: "Minimal Tools"
# body is optional - defaults to empty tool list
```

### Default Values

When `body` is omitted or empty:
- `registry` → `builtin` (auto-detect: builtin if dev mode, http otherwise)
- `bootstrap` → empty list (no tools bootstrapped)
- `tools` → empty list (no custom tools defined)

Applied via [`ToolsBody.empty()`](../core/src/main/java/machinum/manifest/ToolsBody.java#L36-L41).

When `.mt/tools.yaml` is missing entirely, [`Executor.setDefaults()`](../core/src/main/java/machinum/executor/Executor.java#L72-L91) creates an empty tools manifest automatically during setup.

### Full Example

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
description: "AI and utility tools"
metadata:
  created: 2020.01.01
body:
  # Tool registry configuration (optional)
  registry: classpath://default

  # Bootstrap tools list - tools to initialize during setup phase
  bootstrap:
    - prettier
    - eslint
    - workspace

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
      extends: groovy
      config:
        script: "./.mt/scripts/validate.groovy"

    # Git tool - initializes repo and creates commits
    - name: git
      description: "Git repository management"
```

### 3.0 Shorthand Forms

All fields in `tools.yaml` support **shorthand string forms** for concise configuration:

| Field         | Shorthand                       | Object Form                             | Example                                                                               |
|---------------|---------------------------------|-----------------------------------------|---------------------------------------------------------------------------------------|
| `registry`    | `registry: classpath://default` | `registry: classpath://default`         | [`examples/shorthand-test/.mt/tools.yaml`](../examples/shorthand-test/.mt/tools.yaml) |
| `bootstrap[]` | `- tool-name`                   | `- name: tool-name, description: "..."` | See below                                                                             |
| `tools[]`     | `- tool-name`                   | `- name: tool-name, config: {...}`      | See below                                                                             |

**Complete Shorthand Example:**

```yaml
version: 1.0.0
type: tools
name: "Shorthand Tools"
body:
  # Registry
  registry: classpath://default
  
  # Bootstrap list shorthand
  bootstrap:
    - prettier                  # shorthand: name only
    - name: eslint              # object form: full config
      description: "Linting tool"
      config:
        config-file: ".eslintrc"
  
  # Tools list shorthand
  tools:
    - name: translator          # object form: full config
      description: "Translate text"
      config:
        model: gpt-4
        temperature: 0.7
```

> **Note:** Shorthand forms are purely syntactic sugar. Both forms produce identical runtime objects. Use shorthand for simple cases, object form when you need `description` or `config` fields.

See [`examples/shorthand-test/`](../examples/shorthand-test/) for working examples.

### 3.1 Tool Lifecycle

Each tool has an bootstrap lifecycle method:

| Method                             | Phase                 | Description                                                                                                            |
|------------------------------------|-----------------------|------------------------------------------------------------------------------------------------------------------------|
| `bootstrap(BootstrapContext)`      | Bootstrap             | Runs for tools in `body.bootstrap` during `machinum setup bootstrap`; sets up dependencies                             |
| `execute(ExecutionContext)`        | Runtime (conditional) | Runs during pipeline execution when tool is invoked                                                                    |

**Example:**
```java
public class QwenSummary implements Tool {
    @Override
    public void bootstrap(BootstrapContext context) throws Exception {
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

| YAML Section       | Java Record              | File                                                                            |
|--------------------|--------------------------|---------------------------------------------------------------------------------|
| `body`             | `ToolsBody`              | [`ToolsBody.java`](../core/src/main/java/machinum/manifest/ToolsBody.java)      |
| `body.registry`    | `String`                 | Registry URI or shorthand (builtin, file, http, classpath://, file://, http://) |
| `body.bootstrap[]` | `List<String>`           | Bootstrap tool names list                                                       |
| `body.tools[]`     | `ToolDefinitionManifest` | inner class of `ToolsBody`                                                      |
| `tool.config`      | `ToolConfigManifest`     | inner class of `ToolsBody`                                                      |

**Compiled Model:** `ToolsManifest` → `ToolsManifestCompiler` → [`ToolsDefinition`](../core/src/main/java/machinum/definition/ToolsDefinition.java). See [Core Architecture §1.5](core-architecture.md#15-compiled-models).

---

## 4. Pipeline Declaration YAML (`src/main/manifests/pipeline.yaml`)

> **Constraint:** When pipeline has `states`, exactly one of `source` or `items` must be declared. Empty pipelines (no states) are allowed for validation purposes.

### Minimal Example (Empty Body)

```yaml
version: 1.0.0
type: pipeline
name: "minimal-pipeline"
# body is optional - defaults to empty states and variables
```

### Default Values

When `body` is omitted or empty:
- `variables` → empty map
- `config` → `empty` (runtime uses default batch sizes, no cooldown)
- `source` → `void` (must be provided for execution)
- `items` → `none` (must be provided for execution)
- `states` → empty list (no processing states)
- `tools` → empty list (no stateless tools)
- `listeners` → empty map (no lifecycle listeners)
- `fallback` → `default` (runtime uses default error strategy)

Applied via [`PipelineBody.empty()`](../core/src/main/java/machinum/manifest/PipelineBody.java#L35-L41).

**Note:** For pipeline execution, either `source` or `items` must be provided, along with at least one `state` or `tools` entry. See [§4.x source vs items](#4x-source-vs-items--data-acquisition-layer).

### Minimal Executable Example (Stateless Pipeline)

```yaml
version: 1.0.0
type: pipeline
name: "stateless-pipeline"
body:
  source:
    uri: "file://./chapters/test.jsonl"
    #uri: "file://./chapters/*.jsonl"
    #uri: "file://./chapters/?format=jsonl"
  # A pipeline can run without states by using 'tools' directly
  tools:
    - mock-processor
    - tool: text-cleaner
      input: "{{text}}"
```

### Minimal Executable Example (Stateful Pipeline)

```yaml
version: 1.0.0
type: pipeline
name: "simple-pipeline"
body:
  source:
    uri: "file://src/main/chapters?format=md"
  states:
    - name: PROCESS
      tools:
        - mock-processor
```

### 4.1 Source URI Schema

The `source.uri` field uses URI syntax to define data source type and configuration. This replaces the previous multi-field declaration (`type`, `file-location`, `format`, `custom-loader`) with a single URI string.

**Supported URI Schemas:**

| Schema       | Purpose              | Example                                     | Streamer                        |
|--------------|----------------------|---------------------------------------------|---------------------------------|
| `file://`    | Local files/folders  | `file://src/main/chapters?format=md`        | `FileSourceStreamer`            |
| `http://`    | HTTP endpoint        | `http://example.com/data.json`              | `HttpSourceStreamer`            |
| `https://`   | Secure HTTP endpoint | `https://api.example.com/items`             | `HttpSourceStreamer`            |
| `samples://` | Classpath resources  | `samples://default`                         | `SampleSourceStreamer`          |
| `void://`    | No-op source         | `void://`                                   | `VoidSourceStreamer`            |
| `script://`  | Custom Groovy loader | `script://.mt/scripts/custom-loader.groovy` | Post-MVP (throws error for now) |

**Query Parameters:**

| Parameter  | Description                                    | Allowed Values                        | Default   |
|------------|------------------------------------------------|---------------------------------------|-----------|
| `format`   | File format for `file://` schema               | `md`, `json`, `jsonl`, `folder`, `pdf`, `docx`, `txt` | `folder` |

**Examples:**

```yaml
# Local markdown folder
source:
  uri: "file://src/main/chapters?format=md"

# JSONL file
source:
  uri: "file://data/input.jsonl"

# HTTP endpoint
source:
  uri: "https://api.example.com/items"

# Void source - no items, completes immediately
source:
  uri: "void://"

# Custom loader script (post-MVP)
source:
  uri: "script://.mt/scripts/custom-loader.groovy" # doesn't work for now
  variables:
    custom_param: value
```

**Void Source (`void://`):**

Use `void://` when you need a pipeline that processes no items. Useful for:
- Testing pipeline configuration without data
- Stateful operations that don't require input
- Conditional workflows where source is optional

```yaml
# Void pipeline example
version: 1.0.0
type: pipeline
name: "void-test"
body:
  source:
    uri: "void://"
  states:
    - name: INIT
      tools:
        - setup-tool
```

The pipeline runs successfully with 0 items processed. See [Technical Design §3.4](technical-design.md#34-stream-lifecycle-management).

**Samples Source (`samples://`):**

Use `samples://default` to stream defective sample chapters from classpath resources (`/sample/`).
These chapters contain intentional defects for testing pipeline robustness. Useful for:
- Testing pipeline configuration without external data
- Validating defect detection and handling
- Learning Machinum Pipeline with built-in test data

```yaml
# Samples pipeline example
version: 1.0.0
type: pipeline
name: "samples-test"
body:
  source:
    uri: "samples://default"
  states:
    - name: PROCESS
      tools:
        - nooptool
        - tool: testtool
          input: "{{text}}"
```

The `SampleSourceStreamer` streams chapters like `ch1.md` through `ch11.md` (chapter 10 missing).
Each chapter has YAML frontmatter with metadata (title, defects, timeout, age_rating).
See [core/src/main/resources/sample/README.md](../core/src/main/resources/sample/README.md) for the complete defect list.
See [SampleSourceStreamer](../core/src/main/java/machinum/streamer/SampleSourceStreamer.java) for implementation.
See [examples/sample-test/](../examples/sample-test/) for a working example.

### 4.x `source` vs `items` — Data Acquisition Layer

The pipeline manifest accepts **exactly one** of two mutually exclusive data acquisition modes:

| Mode     | Purpose                                                                                                     | Typical Use                                                                                                |
|----------|-------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `source` | **Preprocessor** — acquires raw data from external locations and converts it into pipeline-compatible items | FTP extraction, archive decompression, HTTP download, S3 fetch, git clone, or any custom acquisition logic |
| `items`  | **Direct collection** — references items already available in the workspace as POJOs/chapters               | Pre-downloaded chapters, local MD/MDX files, workspace-resident documents                                  |

**When to use `source`:**
Use a preprocessor when data must be fetched, extracted, or transformed before the pipeline can consume it. The
`source.uri` field defines *where* and *how* to acquire items using URI syntax — file paths, URLs, archives, or custom
loader scripts that convert external formats (PDF, DOCX, remote APIs) into the pipeline's internal item representation.

**When to use `items`:**
Use direct items when your data already exists in the expected format within the workspace. No acquisition step is
needed — the pipeline reads items directly from `src/main/chapters/` or similar locations.

**Flow:**
```
source (preprocessor) → [acquire + convert] → items → [pipeline states]
items (direct)         →                    → items → [pipeline states]
```

Both modes converge to the same item processing pipeline; only the acquisition front differs.

See [Core Architecture §1](core-architecture.md#1-base-models-mvp) for model mapping (`SourceManifest` → `source`, `Item` → items processed by states).

```yaml
version: 1.0.0
type: pipeline
name: "complex-pipeline"
description: "Full AI pipeline with embeddings and translation"
body:
  config:
    batch: 10
    window: 5
    cooldown: 5s
    override: false
    execution:
      snapshot:
        mode: reference
      mode: sequential           # sequential|parallel
      concurrency: 4
    runner:
      type: one_step             # one_step|batch_step|batch_step_over
      options:
        batch: 5
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
    uri: "file://./input/book.zip?format=jsonl"

  items:
    type: chapter                # chapter|paragraph|line|document|page (document|page: post-MVP)
    file-location: "src/main/chapters"   # Path to directory containing item files

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
        - text-cleaner             # Shorthand form (string entry resolving to 'tool')

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
        size: "{{config.batch}}"
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

  interceptors:
    # Shorthand form
    - validation-interceptor
    - tool: metrics-interceptor

  listeners:
    after:
      # Shorthand form
      - md-formatter
      - tool: metrics-collector
        # non-blocking logging, because there no other tool that await the result
        async: true
    finish:
      - tool: notify-webhook
        input: "{{translated_text}}"
      - log-summary                # Shorthand form

  fallback:
    retry:
      max: 3
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

| YAML Section  | Java Record                  | File                                                                                                                              |
|---------------|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `body`        | `PipelineBody`               | [`core/src/main/java/machinum/manifest/PipelineBody.java`](../core/src/main/java/machinum/manifest/PipelineBody.java)             |
| `body.config` | `PipelineConfigManifest`     | [`core/src/main/java/machinum/manifest/PipelineConfigManifest.java`](../core/src/main/java/machinum/manifest/PipelineConfig.java) |
| `body.items`  | `ItemsManifest`              | [`core/src/main/java/machinum/manifest/ItemsManifest.java`](../core/src/main/java/machinum/manifest/ItemsConfig.java)             |
| `body.tools`  | `List<PipelineToolManifest>` | Direct stateless tools execution array (when `states` logic isn't needed)                                                         |

### 4.2 Typed Manifest Records (Root)

The root `body` fields are deserialized into typed Java records in `machinum.manifest`. Each YAML section maps to a record:

| YAML Section                         | Java Record                  | File                                                                                                                                              |
|--------------------------------------|------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `body`                               | `RootBody`                   | [`core/src/main/java/machinum/manifest/RootBody.java`](../core/src/main/java/machinum/manifest/RootBody.java)                                     |

**Compilation path:** `PipelineBody` (typed manifest) → `PipelineManifestCompiler` → `PipelineDefinition` (compiled). See [Technical Design §3.3](technical-design.md#33-value-compilation-system).

**Tool declaration rules:**

- Shorthand: `- tool-name` (Parsed identically to `- name: tool-name`)
- Object form: `- tool: tool-name` or `- name: tool-name`
- `output` defaults to tool name if omitted
- `input` and `output` accept complex objects, maps, or format strings (e.g. `"{{text}}"`)
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

