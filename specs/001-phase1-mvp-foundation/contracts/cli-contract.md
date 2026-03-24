# CLI Contract: Phase 1 MVP Foundation

## Command Surface

### `machinum help`
- **Purpose**: Display CLI usage and available commands.
- **Input**: none
- **Output**: human-readable command usage text.
- **Failure Contract**: exits non-zero on internal command wiring failure.

### `machinum run <pipeline-name> [--dry-run] [--resume <run-id>]`
- **Purpose**: Execute or validate a pipeline.
- **Input**:
  - `pipeline-name` (required)
  - `--dry-run` (optional)
  - `--resume <run-id>` (optional)
- **Output**:
  - run start/finish summary
  - run id for non-dry runs
- **Failure Contract**:
  - invalid manifest -> validation error and non-zero exit
  - missing checkpoint on resume -> resume error and non-zero exit

### `machinum status --run-id <run-id>`
- **Purpose**: Return status for a known run.
- **Input**: `--run-id` (required)
- **Output**: run status summary including state/progress indicators.
- **Failure Contract**: unknown run id -> non-zero exit with message.

### `machinum logs --run-id <run-id>`
- **Purpose**: Return run log stream or tail.
- **Input**: `--run-id` (required)
- **Output**: structured log lines containing run id, item id, state, tool, duration.
- **Failure Contract**: missing log file for run -> non-zero exit with message.

## Behavioral Guarantees
- Manifest validation occurs before execution for all run modes.
- Sequential execution order follows state declaration order.
- Checkpoint writes occur throughout run lifecycle and are used for resume.
