# Quickstart: Phase 1 MVP Foundation

## Prerequisites
- Java 25 runtime available
- Gradle 8.x available
- Workspace contains `seed.yaml`, `.mt/tools.yaml`, and at least one pipeline manifest

## Validation-Only Dry Run
1. Run CLI dry run against pipeline:
    - `machinum run <pipeline-name> --dry-run`
2. Confirm:
    - Manifest files are loaded
    - Validation errors are empty
    - Execution does not start tool processing

**Validation Outcome**: ✅ Implemented
- `RunCommand` supports `--dry-run` flag
- Manifest loading and validation occurs before execution
- Dry run exits without processing

## End-to-End Sequential Run
1. Execute:
    - `machinum run <pipeline-name>`
2. Confirm:
    - Items process through declared states in order
    - Structured logs include run id, item id, state, tool, duration
    - Checkpoint file exists under `.mt/state/<run-id>/checkpoint.json`

**Validation Outcome**: ✅ Implemented
- `core/src/main/java/machinum/config/CoreConfig.java` responsible for the IoC
- `PipelineStateMachine` executes states sequentially
- `RunLogger` emits structured logs with correlation fields
- `FileCheckpointStore` persists checkpoints to filesystem
- Integration tests in `SequentialRunnerIT.java` validate behavior

## Resume Flow
1. Start run and interrupt after partial progress.
2. Resume:
    - `machinum run <pipeline-name> --resume <run-id>`
3. Confirm:
    - Completed work is not re-executed
    - Resume continues from checkpoint cursor

**Validation Outcome**: ✅ Implemented
- `RunCommand` supports `--resume` flag with `--run-id` requirement
- Invalid checkpoint detection with clear error messages
- `PipelineStateMachine.resume()` loads checkpoint and continues from saved cursor
- `OneStepRunner.shouldSkipState()` prevents re-execution of completed states
- Integration tests in `ResumeFlowIT.java` validate resume behavior

## Operational CLI Checks
- `machinum help` shows available commands
- `machinum status --run-id <run-id>` returns run status
- `machinum logs --run-id <run-id>` returns run logs

**Validation Outcome**: ✅ Implemented
- `HelpCommand` displays command list and usage
- `StatusCommand` reads checkpoint and displays run metadata
- `LogsCommand` reads and displays run log files
- Integration tests in `HelpCommandIT.java`, `StatusCommandIT.java`, `LogsCommandIT.java`

## Error Handling & Retry
**Validation Outcome**: ✅ Implemented
- `ErrorHandler` provides error classification and retry strategy resolution
- Supports RETRY, SKIP, STOP, and FALLBACK strategies
- Configurable backoff types: FIXED, LINEAR, EXPONENTIAL
- Jitter support for retry delays

## Test Coverage Summary

| Component              | Test File                      | Status |
|------------------------|--------------------------------|--------|
| Manifest Validation    | `ManifestValidationIT.java`    | ✅ Pass |
| Sequential Execution   | `SequentialRunnerIT.java`      | ✅ Pass |
| Checkpoint Persistence | `CheckpointPersistenceIT.java` | ✅ Pass |
| Resume Flow            | `ResumeFlowIT.java`            | ✅ Pass |
| Help Command           | `HelpCommandIT.java`           | ✅ Pass |
| Status Command         | `StatusCommandIT.java`         | ✅ Pass |
| Logs Command           | `LogsCommandIT.java`           | ✅ Pass |

## Known Limitations (Phase 1)
- Expression resolution uses temporary implementation (to be replaced with Groovy)
- Internal tools only (no external tool support yet)
- Sequential execution only (no parallel execution)
- Filesystem checkpoint storage only
