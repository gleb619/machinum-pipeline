# Tasks: Phase 1 MVP Foundation

**Input**: Design documents from `/specs/001-phase1-mvp-foundation/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/  
**Tests**: Included because the feature follows TDD-style validation and has explicit independent test criteria.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Bootstrap project modules and baseline build/test configuration.

- [x] T001 Create Gradle multi-module skeleton in `settings.gradle` and `build.gradle`
- [x] T002 Create core module package structure under `core/src/main/java/machinum/`
- [x] T003 [P] Create CLI module package structure under `cli/src/main/java/machinum/cli/`
- [x] T004 [P] Initialize baseline test directories in `core/src/test/java/` and `cli/src/test/java/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core runtime contracts and utilities needed by all stories.

- [x] T005 Define manifest root and pipeline model classes in `core/src/main/java/machinum/yaml/`
- [x] T006 Implement YAML loader and strict validation service in `core/src/main/java/machinum/yaml/YamlManifestLoader.java`
- [x] T007 [P] Implement execution context and expression resolver contracts in `core/src/main/java/machinum/pipeline/`
- [x] T008 [P] Implement structured logging utility for run/item/state/tool fields in `core/src/main/java/machinum/pipeline/RunLogger.java`
- [x] T009 Implement checkpoint read/write abstraction in `core/src/main/java/machinum/checkpoint/CheckpointStore.java`
- [x] T010 Implement filesystem-backed checkpoint store in `core/src/main/java/machinum/checkpoint/FileCheckpointStore.java`
- [x] T011 [P] Implement tool registry interfaces and internal tool resolver in `core/src/main/java/machinum/tool/`
- [x] T012 Implement shared CLI runtime configuration loader in `cli/src/main/java/machinum/cli/RuntimeConfigLoader.java`

**Checkpoint**: Foundation complete; user stories can proceed.

---

## Phase 3: User Story 1 - Execute a Manifest-Driven Pipeline (Priority: P1) 🎯 MVP

**Goal**: Run deterministic sequential pipelines from validated manifests.

**Independent Test**: Execute a sample pipeline and verify ordered state progression and stable outcomes.

### Tests for User Story 1

- [x] T013 [P] [US1] Add manifest validation integration test in `core/src/test/java/machinum/yaml/ManifestValidationIT.java`
- [x] T014 [P] [US1] Add sequential state execution integration test in `core/src/test/java/machinum/pipeline/SequentialRunnerIT.java`

### Implementation for User Story 1

- [x] T015 [US1] Implement state machine runner in `core/src/main/java/machinum/pipeline/PipelineStateMachine.java`
- [x] T016 [US1] Implement sequential runner strategy in `core/src/main/java/machinum/pipeline/runner/OneStepRunner.java`
- [x] T017 [US1] Implement state processor and tool invocation flow in `core/src/main/java/machinum/pipeline/StateProcessor.java`
- [x] T018 [US1] Implement `run` command execution path in `cli/src/main/java/machinum/cli/commands/RunCommand.java`

**Checkpoint**: US1 is functional and testable as MVP.

---

## Phase 4: User Story 2 - Resume a Failed or Interrupted Run (Priority: P2)

**Goal**: Recover from interruption via checkpointed resume flow.

**Independent Test**: Interrupt and resume a run, proving completed work is skipped and unfinished work continues.

### Tests for User Story 2

- [x] T019 [P] [US2] Add checkpoint persistence integration test in `core/src/test/java/machinum/checkpoint/CheckpointPersistenceIT.java`
- [x] T020 [P] [US2] Add resume behavior integration test in `core/src/test/java/machinum/pipeline/ResumeFlowIT.java`

### Implementation for User Story 2

- [x] T021 [US2] Implement checkpoint write points in state transition flow in `core/src/main/java/machinum/pipeline/PipelineStateMachine.java`
- [ ] T022 [US2] Implement resume cursor resolution and skip logic in `core/src/main/java/machinum/pipeline/runner/OneStepRunner.java`
- [ ] T023 [US2] Extend run command for `--resume` and invalid checkpoint errors in `cli/src/main/java/machinum/cli/commands/RunCommand.java`

**Checkpoint**: US1 and US2 operate independently with recovery support.

---

## Phase 5: User Story 3 - Operate and Inspect Runs via CLI (Priority: P3)

**Goal**: Provide operator-facing help, status, and logs commands.

**Independent Test**: Use CLI commands against a known run lifecycle and verify expected outputs.

### Tests for User Story 3

- [x] T024 [P] [US3] Add `help` command smoke test in `cli/src/test/java/machinum/cli/HelpCommandIT.java`
- [ ] T025 [P] [US3] Add `status` command integration test in `cli/src/test/java/machinum/cli/StatusCommandIT.java`
- [ ] T026 [P] [US3] Add `logs` command integration test in `cli/src/test/java/machinum/cli/LogsCommandIT.java`

### Implementation for User Story 3

- [x] T027 [US3] Implement help command and command registry wiring in `cli/src/main/java/machinum/cli/commands/HelpCommand.java`
- [x] T028 [US3] Implement status command with run metadata reader in `cli/src/main/java/machinum/cli/commands/StatusCommand.java`
- [x] T029 [US3] Implement logs command with run log reader in `cli/src/main/java/machinum/cli/commands/LogsCommand.java`
- [x] T030 [US3] Add env-file loading behavior to CLI bootstrap in `cli/src/main/java/machinum/cli/EnvironmentLoader.java`

**Checkpoint**: All three stories are independently testable and operational.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final quality pass across all user stories.

- [ ] T031 [P] Update operator documentation in `README.md` and `docs/tdd.md` for Phase 1 command usage
- [ ] T032 Harden error classification and retry strategy wiring in `core/src/main/java/machinum/pipeline/ErrorHandler.java`
- [ ] T033 [P] Validate quickstart scenarios and record outcomes in `specs/001-phase1-mvp-foundation/quickstart.md`

---

## Dependencies & Execution Order

- Phase 1 -> Phase 2 -> Phase 3/4/5 -> Phase 6.
- User stories begin only after foundational tasks T005-T012 are complete.
- US2 depends on US1 runner path (T015-T018) because resume builds on execution flow.
- US3 can begin after Phase 2 and may run alongside US2 if command wiring conflicts are managed.

## Parallel Opportunities

- T003, T004 can run in parallel during setup.
- T007, T008, T011 can run in parallel in foundational work.
- Story test tasks marked `[P]` can run in parallel in each phase.
- Documentation and quickstart validation tasks in Phase 6 can run in parallel.

## Implementation Strategy

1. Deliver MVP by finishing through Phase 3 and validating US1.
2. Add resume reliability via Phase 4.
3. Add operational CLI commands via Phase 5.
4. Complete cross-cutting hardening and docs in Phase 6.
