# Technical Design Document: Machinum Pipeline

**Machinum Pipeline** — pluggable document processing orchestration engine with stateful pipelines, tool composition,
and checkpointing.

---

## Quick Start

### Prerequisites

- Java 25+
- Gradle (wrapper included)

### Try Examples Locally

The fastest way to get started is to explore the working examples in the [`examples/`](../examples/) folder at the project root:

```bash
# Explore available examples
ls examples/

# Run setup for the setup-test example
./gradlew :cli:run --args="setup -w ./examples/setup-test"

# Run a pipeline
./gradlew :cli:run --args="run -p setup-test-pipeline -w ./examples/setup-test"

# Test empty/minimal body configurations
./gradlew :cli:run --args="setup -w ./examples/empty-body-test"

# Test setup on completely empty folder (no manifests)
./gradlew :cli:run --args="setup -w ./examples/fully-empty-folder"
```

See [Project Structure §4](project-structure.md#4-examples-folder) for details about the examples folder.

**Empty Folder Setup:**

When running `machinum setup` on a folder with no manifest files, default values are automatically applied:
- Missing `seed.yaml` → empty root config via [`RootBody.empty()`](../core/src/main/java/machinum/manifest/RootBody.java)
- Missing `.mt/tools.yaml` → empty tools config via [`ToolsBody.empty()`](../core/src/main/java/machinum/manifest/ToolsBody.java)

See [`examples/fully-empty-folder/`](../examples/fully-empty-folder/) for a complete example.

**Minimal Configuration Examples:**

For the simplest possible setup, manifests support optional `body` fields with sensible defaults:

```yaml
# Minimal seed.yaml
version: 1.0.0
type: root
name: "My Project"
# body is optional

# Minimal tools.yaml
version: 1.0.0
type: tools
name: "My Tools"
# body is optional

# Minimal pipeline.yaml
version: 1.0.0
type: pipeline
name: "my-pipeline"
body:
  source:
    uri: "file://src/main/chapters?format=md"
  states:
    - name: PROCESS
      tools:
        - mock-processor
```

See [`examples/empty-body-test/`](../examples/empty-body-test/) for complete minimal examples and [YAML Schema](yaml-schema.md) for all options.

### 1. Prepare Workspace

```
my-project/
├── seed.yaml
└── src/main/
    ├── chapters/
    │   └── 1.md
    └── manifests/
        └── demo-pipeline.yaml
```

### 2. Create `seed.yaml`

Root configuration — see [YAML Schema §2](yaml-schema.md#2-root-pipeline-yaml-rootyml) for all options.

```yaml
version: 1.0.0
type: root
name: "Quick Start"
body:
  variables:
    book_id: quickstart
```

### 3. Create `.mt/tools.yaml`

Tool definitions — see [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml).

```yaml
version: 1.0.0
type: tools
name: "Demo Tools"
body:
  bootstrap:
    - mock-processor
  
  tools:
    - name: mock-processor
      description: "Mock processor for demo"
      config: 
        type: shell
        script: "./.mt/scripts/stub.sh"
```

> **Note:** Tools are declared as a list. Each tool has an `bootstrap()` method that runs based on `bootstrap` declaration during `machinum setup`. See [YAML Schema §3.1](yaml-schema.md#31-tool-lifecycle).

### 4. Create `src/main/manifests/demo-pipeline.yaml`

Pipeline declaration — see [YAML Schema §4](yaml-schema.md#4-pipeline-declaration-yaml-srcmainmanifestspipelineyaml).

```yaml
version: 1.0.0
type: pipeline
name: "demo-pipeline"
body:
  source:
    uri: "file://src/main/chapters?format=md"
  tools:
    - tool: mock-processor
```

> **Note:** This example uses `source` to read from a local directory. Use `source` when data must be acquired/converted (FTP, download, archive extraction). Use `items` when data already exists as workspace POJOs. See [YAML Schema §4.x](yaml-schema.md#4x-source-vs-items--data-acquisition-layer) for details.

### 5. Add Input File `src/main/chapters/1.md`

```markdown
# Chapter One

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
```

### 6. Setup Tools

```bash
./gradlew :cli:run --args="setup -w ./my-project"
```

This runs the `bootstrap()` method on all internal tools defined in `.mt/tools.yaml`.

### 7. Run Pipeline

```bash
./gradlew :cli:run --args="run -p demo-pipeline -w ./my-project"
```

See [CLI Commands](cli-commands.md) for full reference.

### 8. Verify Results

**Before run:**

```
my-project/
├── seed.yaml
└── src/main/
    ├── chapters/
    │   └── 1.md
    └── manifests/
        └── demo-pipeline.yaml
```

**After run:**

```
my-project/
├── seed.yaml
├── .mt/                              ← generated
│   └── state/
│       └── {run-id}/
│           ├── checkpoint.json       ← item progress
│           └── items.json            ← limitted item payloads based on batch config/runner setup 
├── src/main/
│   ├── chapters/
│   │   └── 1.md
│   └── manifests/
│       └── demo-pipeline.yaml
└── build/                            ← generated
    └── demo-pipeline/
        └── 1.md                      ← alternative processed output
```

> **Note:** The result of pipelining can be placed in the `build` folder or in another subfolder of `src/main/chapters`

See [Project Structure §1](project-structure.md#1-workspace-directory-structure) for directory layout,
[Core Architecture §3](core-architecture.md#3-checkpointing--state-management) for checkpoint details.

---

## Document Index

| Document                                  | Description                                                                 |
|-------------------------------------------|-----------------------------------------------------------------------------|
| [Technical Design](technical-design.md)   | Architecture, execution models, error handling, Groovy integration, roadmap |
| [YAML Schema](yaml-schema.md)             | Configuration file formats: root, tools, and pipeline manifests             |
| [Core Architecture](core-architecture.md) | Runtime architecture, state management, checkpointing, admin UI             |
| [CLI Commands](cli-commands.md)           | Command-line interface reference                                            |
| [Project Structure](project-structure.md) | Directory layout, Gradle modules, workspace organization                    |
| [Value Compilers](value-compilers.md)     | Verious information about runtime evaluation of groovy scripts              |
| [Examples](../examples/)                  | Working examples for testing and learning                                   |

---

## Quick Reference

### For Implementation

- Start with [YAML Schema](yaml-schema.md) to define your pipeline configuration
- Reference [CLI Commands](cli-commands.md) for execution and management
- Consult [Project Structure](project-structure.md) for workspace layout

### For Architecture Understanding

- Read [Technical Design](technical-design.md) for high-level design and decisions
- Review [Core Architecture](core-architecture.md) for runtime behavior and state management

---

**Document Version:** 2.4
**Last Updated:** 2026-04-01
**Status:** Developing Phase 1