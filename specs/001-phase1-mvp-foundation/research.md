# Phase 0 Research: Phase 1 MVP Foundation

## Decision 1: Deterministic runner strategy
- **Decision**: Implement only `one_step` sequential processing for Phase 1.
- **Rationale**: Satisfies constitutional deterministic requirement and reduces ambiguity
  in checkpoint cursor behavior.
- **Alternatives considered**:
  - Early parallel processing: rejected due to non-deterministic ordering risk.
  - Batch-first runner: deferred to later phase to avoid premature complexity.

## Decision 2: Configuration validation model
- **Decision**: Use strict schema-backed validation at manifest load time with fail-fast
  errors.
- **Rationale**: Prevents runtime drift and enforces explicit constraints such as
  `source` XOR `items`.
- **Alternatives considered**:
  - Lenient parsing with runtime warnings: rejected due to unclear operator outcomes.
  - Partial schema checks per state: rejected as inconsistent and hard to test.

## Decision 3: Checkpoint persistence scope
- **Decision**: Use local filesystem snapshots in `.mt/state/<run-id>/` with explicit
  cursor fields for resume.
- **Rationale**: Matches MVP requirements and keeps recovery operational without extra
  infrastructure.
- **Alternatives considered**:
  - External state backend: deferred; outside Phase 1 and adds setup overhead.
  - In-memory only checkpoint: rejected because it cannot support process resume.

## Decision 4: CLI-first operational contract
- **Decision**: Deliver and validate only `run`, `help`, `status`, and `logs` commands.
- **Rationale**: Meets MVP operator workflow and constitutional CLI-first requirement.
- **Alternatives considered**:
  - Introduce server mode now: deferred to Phase 4 in TDD roadmap.
  - Add install/cleanup in Phase 1: deferred to Phase 2 command scope.
