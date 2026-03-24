# Feature Specification: Phase 1 MVP Foundation

**Feature Branch**: `001-phase1-mvp-foundation`  
**Created**: 2026-03-24  
**Status**: Draft  
**Input**: User description: "Phase 1 MVP foundation: YAML loading with unified body manifests, internal tool registry support, sequential state-machine execution, checkpointing basics, CLI MVP commands run/help/status/logs, and logging plus env-file loading"

## Clarifications

### Session 2026-03-24

- Q: What is explicitly included in this Phase 1 feature scope? -> A: YAML loading, internal tools, sequential execution, checkpoint/resume, CLI run-help-status-logs, structured logging, and env-file loading.
- Q: What is explicitly excluded from this feature scope? -> A: Parallel execution, Docker external runtime maturity, server mode, admin UI, and action endpoints are excluded.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Execute a Manifest-Driven Pipeline (Priority: P1)

As a pipeline operator, I can run a configured pipeline from workspace manifests so
that items move through ordered states and produce deterministic results.

**Why this priority**: This is the core product value; without deterministic pipeline
execution there is no usable MVP.

**Independent Test**: Can be fully tested by executing a sample manifest with a small
set of items and confirming state progression and outputs in a single run.

**Acceptance Scenarios**:

1. **Given** a valid root config, tools config, and pipeline manifest,
   **When** the operator runs the pipeline command, **Then** the engine loads all
   manifests and processes items through states in declared order.
2. **Given** a state with condition and tool declarations, **When** each item is
   evaluated, **Then** only matching states and tools run and outputs are attached to
   the item context.
3. **Given** the same input manifests and items, **When** the pipeline is run twice in
   sequential mode, **Then** state transition order and completion outcomes are
   consistent between runs.

---

### User Story 2 - Resume a Failed or Interrupted Run (Priority: P2)

As an operator, I can resume processing from checkpointed state so that partial work
is not lost after interruption.

**Why this priority**: Resume capability protects runtime reliability and operational
cost once basic execution works.

**Independent Test**: Can be tested by interrupting a run after partial completion and
confirming resume continues from saved state without reprocessing completed work.

**Acceptance Scenarios**:

1. **Given** an in-progress run with persisted checkpoint state, **When** the process
   is interrupted and restarted in resume mode, **Then** completed states are skipped
   and unfinished work continues from the saved cursor.
2. **Given** no checkpoint for a requested run id, **When** resume is requested,
   **Then** the system reports a clear error and does not start an invalid resume flow.

---

### User Story 3 - Operate and Inspect Runs via CLI (Priority: P3)

As a CLI user, I can run, inspect status, and read logs from standard commands so
that I can operate the system without server UI dependencies.

**Why this priority**: Operational commands are needed for day-to-day usage but depend
on core execution and checkpoint behaviors.

**Independent Test**: Can be tested by invoking `help`, `run`, `status`, and `logs`
against a known run lifecycle and validating command responses.

**Acceptance Scenarios**:

1. **Given** an initialized workspace, **When** the user invokes `help`, **Then** the
   command list and usage details are shown.
2. **Given** an active or completed run id, **When** the user invokes `status` and
   `logs`, **Then** current run state and structured log output are returned.

---

### Edge Cases

- Invalid or missing manifest fields (including malformed YAML) fail fast with
  actionable validation errors before execution begins.
- If both `source` and `items` are declared, or both are absent, pipeline validation
  fails and the run is rejected.
- Missing referenced tools or script paths produce deterministic errors that identify
  the failing state and tool reference.
- If env files (`.env`, `.ENV`) are missing, execution proceeds using available
  environment values and logs the missing optional files.
- On crash or forced termination during processing, the latest checkpoint remains
  readable for resume attempts.

### Assumptions

- The workspace layout follows the document structure defined in `docs/tdd.md`.
- Initial Phase 1 implementation supports internal tools only; external tool support
  is deferred to later phases.
- Checkpoint persistence uses local filesystem storage for MVP.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST load and validate root, tools, and pipeline manifests that
  use a unified `body` payload structure.
- **FR-002**: System MUST enforce pipeline declaration constraints, including
  requirement that exactly one of `source` or `items` is provided.
- **FR-003**: System MUST provide an internal tool registry capable of resolving tool
  definitions by name for MVP internal tools.
- **FR-004**: System MUST execute pipeline states in deterministic sequential mode for
  MVP.
- **FR-005**: System MUST evaluate state and tool conditions against execution context
  variables before invocation.
- **FR-006**: System MUST persist checkpoint snapshots during execution so interrupted
  runs can resume from saved progress.
- **FR-007**: System MUST support resume using a run identifier and skip already
  completed work based on checkpoint data.
- **FR-008**: System MUST expose CLI commands `run`, `help`, `status`, and `logs`.
- **FR-009**: System MUST emit structured run logs containing run id, item id, state,
  tool, and duration fields.
- **FR-010**: System MUST load environment values from `.env` and `.ENV` files when
  present and make them available to runtime expression resolution.

### Key Entities *(include if feature involves data)*

- **RunMetadata**: Identifies a run and stores lifecycle fields such as run id,
  pipeline name, start/update timestamps, and status.
- **CheckpointSnapshot**: Captures resumable execution state including state cursor,
  item progress summary, and links to item payload state.
- **PipelineManifest**: Declares execution config, source/items declaration, ordered
  states, and terminal listeners.
- **StateDefinition**: Represents one pipeline state with optional condition and one
  or more tool declarations.
- **ToolDefinition**: Represents tool metadata and configuration required for internal
  tool resolution and execution.
- **ExecutionContext**: Runtime key-value map used for expression resolution, variable
  substitution, and condition evaluation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For valid manifests, operators can start a complete sequential pipeline
  run from CLI with no manual code changes in at least 95% of trial runs.
- **SC-002**: For interrupted runs with checkpoints, resume continues from saved
  progress and avoids re-running already completed states in at least 95% of tests.
- **SC-003**: Validation failures for malformed or invalid manifests are reported
  before execution starts in 100% of negative test cases.
- **SC-004**: Operators can retrieve run status and structured logs for completed runs
  using CLI commands within one command invocation per action.
