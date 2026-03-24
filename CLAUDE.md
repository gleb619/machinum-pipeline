# machinum-pipeline
State-machine based document processing pipeline with pluggable tools and checkpoint/resume semantics.

## Current Repository Status
- Repository is currently documentation/bootstrap focused.
- `docs/tdd.md` describes architecture intent, not full implemented reality.
- Do not assume `build.gradle`, `settings.gradle`, `src/`, tests, or Gradle wrapper exist until verified.

## Architecture Intent
- Pipeline orchestration is modeled as a state machine over items.
- Each state runs one or more tools, optionally guarded by Groovy expressions/scripts.
- Checkpoint persistence enables resume (`.mt/state/{run-id}/checkpoint.json`).
- Tool execution supports both:
  - internal in-process Java tools
  - external shell/docker style tools
- Planned module boundaries:
  - `core`
  - `cli`
  - `server`
  - `mcp`

## Config Model Intent
- Root config: `mt-pipeline.yaml`
- Internal config/state under `.mt/`:
  - `.mt/tools.yaml`
  - `.mt/pipeline.yaml`
  - `.mt/state/{run-id}/checkpoint.json`

## Key Working Rules
- Keep changes incremental and minimal (small, reviewable diffs).
- Before coding, verify actual implementation files that exist now.
- Never invent runnable commands when build/test scaffolding is not present.
- Preserve intended behaviors from TDD:
  - state-by-state execution
  - checkpoint + resume flow
  - error strategies (`stop` / `skip` / `retry`)
  - support for internal and external tools
- Do not delete files or remove tests without explicit user request.
- If requirements are ambiguous, ask instead of guessing.

## Preferred Workflow
1. Research relevant files first.
2. For complex tasks: produce a short implementation plan.
3. Implement in small steps.
4. Validate with commands that actually exist in repo.
5. Summarize changed files and any follow-up steps.

## Agents
- Use `planner` for architecture-aware planning before complex implementation.
- Use `tester` after code changes to add/adjust tests and run available checks.
- Use `code-reviewer` before commit/merge to catch regressions and design drift.
