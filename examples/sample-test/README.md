# Sample Test Example

This example demonstrates a complete Machinum Pipeline workflow that:
1. Streams defective sample chapters from classpath resources via `samples://default`
2. Runs a pipeline with `nooptool`, `testtool` on the chapters
3. Saves processed output to `src/main/chapters/` directory

## Directory Structure

```
examples/sample-test/
├── seed.yaml                              # Root configuration
├── .mt/
│   └── tools.yaml                         # Tool definitions
└── src/main/
    ├── chapters/                          # Output directory for processed chapters
    └── manifests/
        └── sample-pipeline.yaml           # Pipeline definition
```

## Quick Start

```bash
# 1. Setup workspace (bootstrap writer; create directories)
./gradlew :cli:run --args="setup -w ./examples/sample-test" -PbuiltinToolsEnabled=true

# 2. Run the pipeline (streams from samples://default)
./gradlew :cli:run --args="run -p sample-pipeline -w ./examples/sample-test" -PbuiltinToolsEnabled=true

# 3. Check results
ls examples/sample-test/src/main/chapters/   # Should have *-processed.md files
ls examples/sample-test/build/               # Pipeline output
ls examples/sample-test/.mt/state/           # Run state and checkpoints
```

## Tools Used

| Tool | Description |
|------|-------------|
| `writer` | Copies sample chapters from `/sample/` classpath resources to workspace during setup |
| `nooptool` | No-operation tool (passes input through unchanged) |
| `testtool` | Test tool that appends `[processed-by-testtool]` to content |

## Documentation References

- **[YAML Schema](../../docs/yaml-schema.md)** — Configuration file formats
  - [Root YAML](../../docs/yaml-schema.md#2-root-pipeline-yaml-rootyml) — `seed.yaml` format
  - [Tools YAML](../../docs/yaml-schema.md#3-tools-yaml-mttoolsyaml) — `.mt/tools.yaml` format
  - [Pipeline YAML](../../docs/yaml-schema.md#4-pipeline-declaration-yaml-srcmainmanifestspipelineyaml) — Pipeline manifests
  - [Source URI Schema](../../docs/yaml-schema.md#41-source-uri-schema) — `samples://default` and other URI formats
  - [Source vs Items](../../docs/yaml-schema.md#4x-source-vs-items--data-acquisition-layer) — Data acquisition modes

- **[CLI Commands](../../docs/cli-commands.md)** — Command reference
  - `setup` — Bootstrap tools and create workspace
  - `run` — Execute pipeline

- **[Core Architecture](../../docs/core-architecture.md)** — Runtime architecture
  - [Checkpointing](../../docs/core-architecture.md#3-checkpointing--state-management) — State management

- **[Project Structure](../../docs/project-structure.md)** — Directory layout
  - [Workspace Structure](../../docs/project-structure.md#1-workspace-directory-structure) — Expected directories
  - [Examples](../../docs/project-structure.md#4-examples-folder) — Example usage

- **[Technical Design](../../docs/technical-design.md)** — High-level design
  - [Tool Interface](../../docs/technical-design.md#32-core-interfaces) — Tool contract
  - [Stream Lifecycle](../../docs/technical-design.md#34-stream-lifecycle-management) — Streamer callbacks

- **[Value Compilers](../../docs/value-compilers.md)** — Expression evaluation
  - Expression compilation for `{{text}}` templates

- **[TDD Guide](../../docs/tdd.md)** — Test-driven development
  - [Quick Start](../../docs/tdd.md#quick-start) — Getting started guide

## Sample Chapters

The pipeline uses `SampleSourceStreamer` to stream chapters from `core/src/main/resources/sample/`:
- `ch1.md` through `ch9.md` and `ch11.md` (chapter 10 is intentionally missing)
- Each chapter has YAML frontmatter with metadata (title, word_count, age_rating, defects, timeout)
- Chapters contain intentional defects for testing pipeline robustness

See [sample/README.md](../../core/src/main/resources/sample/README.md) for the complete defect list.
See [SampleSourceStreamer](../../core/src/main/java/machinum/streamer/SampleSourceStreamer.java) for implementation.
See [SaveContentTool](../../tools/internal/src/main/java/machinum/tool/SaveContentTool.java) for the save tool.
