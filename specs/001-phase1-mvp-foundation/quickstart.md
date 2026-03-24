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

## End-to-End Sequential Run
1. Execute:
   - `machinum run <pipeline-name>`
2. Confirm:
   - Items process through declared states in order
   - Structured logs include run id, item id, state, tool, duration
   - Checkpoint file exists under `.mt/state/<run-id>/checkpoint.json`

## Resume Flow
1. Start run and interrupt after partial progress.
2. Resume:
   - `machinum run <pipeline-name> --resume <run-id>`
3. Confirm:
   - Completed work is not re-executed
   - Resume continues from checkpoint cursor

## Operational CLI Checks
- `machinum help` shows available commands
- `machinum status --run-id <run-id>` returns run status
- `machinum logs --run-id <run-id>` returns run logs
