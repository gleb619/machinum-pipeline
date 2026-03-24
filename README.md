# machinum-pipeline
Pluggable document processing orchestration engine with state machine–based pipelines, tool composition, checkpointing, and hybrid CLI/server operation

## Spec-Kit (OpenCode) Setup

Spec-Kit is initialized for this repository and provides workflow commands for OpenCode.

- Spec-Kit project files: `.specify/`
- OpenCode command files: `.opencode/command/`

Recommended command order in OpenCode:

1. `/speckit.constitution`
2. `/speckit.specify`
3. `/speckit.clarify` (optional, recommended)
4. `/speckit.plan`
5. `/speckit.tasks`
6. `/speckit.analyze` (optional, recommended)
7. `/speckit.implement`

If you are not using Git branch-based feature detection, set `SPECIFY_FEATURE` (for example `001-feature-name`) before running `/speckit.plan` and later steps.
