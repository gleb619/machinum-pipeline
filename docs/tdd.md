# Technical Design Document: Machinum Pipeline

**Machinum Pipeline** — pluggable document processing orchestration engine with stateful pipelines, tool composition,
and checkpointing.

---

## Quick Start

### Prerequisites

- Java 25+
- Gradle (wrapper included)

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
  metadata:
    book_id: quickstart
  execution:
    resume: true
```

### 3. Create `.mt/tools.yaml`

Tool definitions — see [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml).

```yaml
version: 1.0.0
type: tools
name: "Demo Tools"
body:
  execution-targets:
    default: local
    targets:
      - name: local
        type: local

  tools:
    - name: mock-processor
      description: "Mock processor for demo"
```

> **Note:** Tools are declared as a flat list (no states). Each internal tool has an `install()` method that runs unconditionally during `machinum setup`. See [YAML Schema §3.1](yaml-schema.md#31-tool-lifecycle).

### 4. Create `src/main/manifests/demo-pipeline.yaml`

Pipeline declaration — see [YAML Schema §4](yaml-schema.md#4-pipeline-declaration-yaml-srcmainmanifestspipelineyaml).

```yaml
version: 1.0.0
type: pipeline
name: "demo-pipeline"
body:
  source:
    type: file
    file-location: "src/main/chapters"
    format: md
  states:
    - name: PROCESS
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
│           └── items.json            ← item payloads
├── src/main/
│   ├── chapters/
│   │   └── 1.md
│   └── manifests/
│       └── demo-pipeline.yaml
└── build/                            ← generated
    └── demo-pipeline/
        └── 1.md                      ← processed output
```

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

**Document Version:** 2.1
**Last Updated:** 2026-03-28
**Status:** Approved for Phase 1 Development