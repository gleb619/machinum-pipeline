# Implementation Plan: Phase 1 MVP Foundation

**Branch**: `001-phase1-mvp-foundation` | **Date**: 2026-03-24 | **Spec**: `specs/001-phase1-mvp-foundation/spec.md`
**Input**: Feature specification from `/specs/001-phase1-mvp-foundation/spec.md`

## Summary

Deliver a deterministic CLI-first MVP for manifest-driven pipeline processing. The
implementation covers validated YAML loading, internal tool registry resolution,
sequential state-machine execution, checkpoint/resume behavior, and structured run
observability.

## Technical Context

**Language/Version**: Java 25  
**Primary Dependencies**: Gradle 8.x, Picocli, SnakeYAML, Jackson, SLF4J + Logback  
**Storage**: Local filesystem for run state and checkpoints (`.mt/state/<run-id>/`)  
**Testing**: JUnit 5 + integration tests for CLI and pipeline flows  
**Target Platform**: Linux and macOS CLI environments  
**Project Type**: Multi-module CLI/backend foundation project  
**Performance Goals**: Runtime orchestration overhead under 100ms per item excluding tool execution  
**Constraints**: Deterministic sequential mode only in Phase 1; no server/UI dependency; fail-fast validation  
**Scale/Scope**: Up to 10,000 items per run in MVP scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Pass: Spec-first delivery enforced; artifacts generated under `specs/001-phase1-mvp-foundation/`.
- Pass: Deterministic sequential execution remains the only execution mode in scope.
- Pass: Contract-driven YAML validation and source/items exclusivity are explicit requirements.
- Pass: Checkpoint/resume and structured observability are included as primary outcomes.
- Pass: CLI-first interface (`run`, `help`, `status`, `logs`) is a hard MVP boundary.

## Project Structure

### Documentation (this feature)

```text
specs/001-phase1-mvp-foundation/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
core/
└── src/main/java/machinum/
    ├── pipeline/
    ├── tool/
    ├── state/
    ├── yaml/
    ├── groovy/
    └── checkpoint/

cli/
└── src/main/java/machinum/cli/

tools/
├── common/
├── internal/
└── external/

core/src/test/java/
cli/src/test/java/
```

**Structure Decision**: Adopt the multi-module structure from `docs/tdd.md` for core
engine, CLI surface, and tool abstractions, while implementing only Phase 1-required
components in this feature.

## Complexity Tracking

No constitutional violations or complexity exemptions are required for this plan.
