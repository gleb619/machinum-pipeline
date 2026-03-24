# Data Model: Phase 1 MVP Foundation

## RunMetadata
- **Purpose**: Track lifecycle and identity of a pipeline execution run.
- **Fields**:
  - `runId` (string, required, unique)
  - `pipelineName` (string, required)
  - `status` (enum: pending|running|completed|failed|stopped)
  - `startedAt` (timestamp, required)
  - `lastUpdatedAt` (timestamp, required)
- **Rules**:
  - `runId` uniqueness is repository-local.
  - Status transitions are monotonic except resume path from `failed` or `stopped` to `running`.

## CheckpointSnapshot
- **Purpose**: Persist resumable state for interrupted or paused runs.
- **Fields**:
  - `runId` (string, required)
  - `stateIndex` (integer, required, >= 0)
  - `itemOffset` (integer, required, >= 0)
  - `windowId` (string, optional; reserved for batch/window runners)
  - `itemsFile` (path/string, optional)
  - `itemsSummary` (array of item status summaries)
- **Rules**:
  - Snapshot MUST be writable after each state transition.
  - Resume MUST reject snapshots whose `runId` does not match requested run.

## PipelineManifest
- **Purpose**: Define execution behavior and state graph for one pipeline.
- **Fields**:
  - `version` (string, required)
  - `type` (string, required; must equal `pipeline`)
  - `name` (string, required)
  - `body.config` (object, required)
  - `body.source` (object, conditional)
  - `body.items` (object, conditional)
  - `states` (ordered array, required)
- **Rules**:
  - Exactly one of `body.source` or `body.items` MUST be present.
  - `states` must preserve declared order during execution.

## StateDefinition
- **Purpose**: Describe one executable state in the pipeline flow.
- **Fields**:
  - `name` (string, required)
  - `condition` (template string, optional)
  - `tools` (array of tool declarations, required unless state is wait/fork type)
  - `waitFor` (duration, optional)
- **Rules**:
  - If `condition` evaluates false, state is skipped for that item.
  - Tools in Phase 1 execute sequentially.

## ToolDefinition
- **Purpose**: Describe an internal tool entry resolvable at runtime.
- **Fields**:
  - `name` (string, required, unique in registry)
  - `type` (enum: internal|external; Phase 1 uses internal only)
  - `config` (object, optional)
- **Rules**:
  - Referenced tool names in states MUST exist in registry.
  - Unknown tools are validation errors, not runtime warnings.
