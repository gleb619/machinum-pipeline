# Implementation Plan: External Tools & Workspace Management

**Branch**: `002-external-tools-support` | **Date**: 2026-03-25 | **Spec**: `specs/002-external-tools-support/spec.md`
**Input**: Feature specification from `/specs/002-external-tools-support/spec.md`

## Summary

Implement external tool support (shell/Groovy scripts), workspace initialization via `machinum install` command, cleanup command with policy-based retention, and Groovy-based expression resolution. This extends Phase 1's internal-only foundation to support extensible, scriptable pipeline processing.

## Technical Context

**Language/Version**: Java 25
**Primary Dependencies**: Gradle 8.x (actually 9.4.1), Picocli 4.7+, SnakeYAML 2.0+, Jackson 2.17+, Groovy 4.0+, SLF4J + Logback
**Storage**: Local filesystem for run state, checkpoints, and workspace structure (`.mt/`, `src/main/`, `build/`)
**Testing**: JUnit 5 + integration tests for CLI commands and external tool execution
**Target Platform**: Linux and macOS CLI environments
**Project Type**: Multi-module CLI/backend foundation project
**Performance Goals**: External tool execution overhead under 50ms per tool (excluding script runtime); expression resolution under 10ms per variable
**Constraints**: Shell tools must honor timeout/retry; Groovy scripts must be sandboxed; workspace init must be idempotent; cleanup must be policy-driven
**Scale/Scope**: Support up to 100 external script invocations per run; workspace init completes in under 5 seconds

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Pass: Spec-first delivery enforced; artifacts generated under `specs/002-external-tools-support/`.
- Pass: External tools integrate with existing deterministic execution model (no parallelism introduced).
- Pass: Contract-driven YAML validation extends to external tool declarations with explicit schema.
- Pass: Checkpoint/resume semantics unchanged; external tools emit structured logs with correlation IDs.
- Pass: CLI-first interface extended (`install`, `cleanup`) without blocking MVP completion.

## Project Structure

### Documentation (this feature)

```text
specs/002-external-tools-support/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
core/
└── src/main/java/machinum/
    ├── tool/
    │   ├── ExternalTool.java          # Base class for external tools
    │   ├── ShellTool.java             # Shell script execution
    │   └── GroovyScriptTool.java      # Groovy script execution
    ├── expression/
    │   ├── ExpressionResolver.java    # Interface
    │   ├── GroovyExpressionResolver.java  # Implementation
    │   └── ExpressionContext.java     # Context holder
    ├── workspace/
    │   ├── WorkspaceInitializerTool.java  # Bootstrap logic tool
    │   └── WorkspaceLayout.java       # Directory structure definition
    └── cleanup/
        ├── CleanupCommand.java        # CLI handler
        └── CleanupPolicy.java         # Retention logic

cli/
└── src/main/java/machinum/cli/
    ├── InstallCommand.java            # install/download/bootstrap
    └── CleanupCommand.java            # cleanup with options

tools/
├── common/
├── internal/
└── external/
    └── scripts/
        ├── conditions/
        ├── transformers/
        └── validators/

core/src/test/java/
cli/src/test/java/
```

**Structure Decision**: Adopt the multi-module structure from `docs/tdd.md`, adding new packages for external tools, expression resolution, workspace management, and cleanup. External tools extend the existing `Tool` interface from Phase 1.

## Complexity Tracking

No constitutional violations or complexity exemptions are required for this plan.
