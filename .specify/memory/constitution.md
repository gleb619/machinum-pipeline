<!--
Sync Impact Report
- Version change: N/A -> 1.0.0
- Modified principles: Initialized all five core principles from template placeholders
- Added sections: Technical Constraints, Development Workflow & Quality Gates
- Removed sections: None
- Templates requiring updates:
  - ✅ .specify/templates/constitution-template.md (no update required, generic template)
  - ✅ .specify/templates/spec-template.md (compatible)
  - ✅ .specify/templates/plan-template.md (compatible)
  - ✅ .specify/templates/tasks-template.md (compatible)
- Follow-up TODOs: None
-->

# Machinum Pipeline Constitution

## Core Principles

### I. Spec-First Delivery (Non-Negotiable)
All implementation work MUST begin from an approved spec directory under
`.specify/specs/<feature>/`. Teams MUST complete the ordered flow
`specify -> clarify -> plan -> analyze -> tasks` before implementation.
Unplanned code changes are prohibited unless explicitly authorized as an override.

### II. Deterministic Pipeline Core for MVP
Phase 1 development MUST prioritize deterministic, sequential execution behavior.
Features that introduce non-deterministic behavior (parallel execution, distributed
state, or speculative execution) MUST be deferred or explicitly marked post-MVP.

### III. Contract-Driven Configuration
YAML artifacts (`root`, `tools`, `pipeline`) MUST be validated against explicit
schemas and constraints defined in the current spec set. Parsing and validation MUST
fail fast on ambiguous or invalid configuration. Exactly one of `source` or `items`
must be present in pipeline declarations.

### IV. Observable and Recoverable Runs
All run-time paths MUST emit structured logs with run and item correlation fields and
MUST support checkpoint/resume semantics for Phase 1 scope. A run is considered
production-ready only if state can be resumed from persisted checkpoint artifacts
without manual mutation.

### V. Incremental CLI-First Surface
User-facing capability MUST land through CLI-first workflows before broader surfaces.
Phase 1 command set (`run`, `help`, `status`, `logs`) is the required baseline.
Server/UI capabilities may be planned but MUST not block MVP completion.

## Technical Constraints

- Primary runtime MUST target Java 25 with Gradle 8.x build conventions.
- Config and serialization stack MUST align with SnakeYAML and Jackson.
- CLI flows MUST remain compatible with Picocli command design.
- Dependencies and module boundaries SHOULD follow the architecture described in
  `docs/tdd.md`.
- Post-MVP items (parallel runners, Docker maturity, admin action endpoints) MUST be
  isolated from Phase 1 acceptance criteria.

## Development Workflow & Quality Gates

- Every feature MUST have testable functional requirements and measurable success
  criteria in `spec.md`.
- `plan.md` MUST include a constitution check and resolve unknowns before tasking.
- `tasks.md` MUST be dependency-ordered, executable, and mapped to user stories.
- `analyze` findings marked CRITICAL MUST be resolved before implementation.
- Any requirement change during implementation MUST update spec first, then re-run
  planning and tasks.

## Governance

This constitution is authoritative for delivery process and quality gates in this
repository. Any pull request or change review MUST confirm constitutional compliance.
Amendments require:
1) rationale describing impact and migration expectations,
2) explicit version bump by semantic intent,
3) regeneration or validation of dependent spec-kit artifacts.

If a rule conflict appears between ad hoc guidance and this constitution, this file
takes precedence until formally amended.

**Version**: 1.0.0 | **Ratified**: 2026-03-24 | **Last Amended**: 2026-03-24
