# CLAUDE.md
## AGENTS.md

Before starting work, read `docs/tdd.md` as high-level design intent — not an implementation spec.
Code structure, APIs, and names do not need exact 1:1 matching.

---

## Project

**Machinum Pipeline** — pluggable document processing orchestration engine with stateful pipelines,
tool composition, and checkpointing. Processes items (chapters, docs, files) through state-machine
pipelines with internal (Java) and external (Shell/Docker) tools.

### Modules

| Module           | Role                                                            |
|------------------|-----------------------------------------------------------------|
| `core`           | Pipeline engine, YAML loading, state machine, checkpointing     |
| `cli`            | Picocli entry point — `run`, `setup`, `serve`, `status`, `logs` |
| `server`         | Jooby HTTP server + admin UI                                    |
| `tools:common`   | Shared abstractions, `ToolRegistry`, `ExecutionContext`         |
| `tools:internal` | Built-in Java tools (SPI-registered)                            |
| `tools:external` | Shell/Docker wrappers                                           |

Design docs index: `docs/tdd.md`

---

## Formatting — Spotless + Palantir Java Format

- **Formatter**: Spotless with Palantir Java Format
- **Indentation**: 2 spaces (Google Java Style) — never tabs, never 4 spaces
- Run `./gradlew spotlessApply` **before every test run and before committing**
- CI enforces `./gradlew spotlessCheck` — do not bypass or disable it
- Do not manually reformat code — let Spotless handle it
- **Javadoc**: allowed only on public classes; methods and fields must NOT have Javadoc
- Use `var` where explicit type doesn't add clarity

---

## Mandatory TDD Process

All development MUST follow red → green → refactor:

1. **Red** — write or update a failing test for the target behavior first
2. **Green** — implement minimal code to make the test pass
3. **Refactor** — clean up while keeping tests green

Do not start implementation before a failing test exists (unless task is explicitly non-code).

### Test Commands

```bash
# Format first (always)
./gradlew spotlessApply

# Test a specific class
./gradlew :core:test --tests "machinum.SomeClassTest"
./gradlew :cli:test --tests "machinum.cli.SomeCommandTest"

# Test a specific module
./gradlew :core:test
./gradlew :tools:internal:test

# Full suite (required before handoff/commit)
./gradlew test

# Format check (CI)
./gradlew spotlessCheck
```

---

## Agent Workflow

For any non-trivial task, invoke the **`agent-workflow` skill** via the Skill tool.
It coordinates three specialized agents: `planner`, `code-reviewer`, `tester`.

### When to Use Which Agent

| Situation                         | Action                                                    |
|-----------------------------------|-----------------------------------------------------------|
| New feature or significant change | Invoke `planner` agent first                              |
| After each implementation chunk   | Invoke `tester` agent                                     |
| Before completing / merging       | Invoke `code-reviewer`, then `tester`                     |
| Bug fix                           | `planner` → implement → `tester` → `code-reviewer`        |
| Refactor                          | Ensure tests pass → refactor → `tester` → `code-reviewer` |

### Standard Sequence (complex tasks)

```
planner → implement (red→green→refactor) → code-reviewer → tester
```

### Agent Files

- `.claude/agents/planner.md` — creates TDD-first implementation plans; never writes code
- `.claude/agents/code-reviewer.md` — regressions, security, quality, pattern compliance
- `.claude/agents/tester.md` — TDD compliance, coverage, regression prevention

### Skill Invocation

Use the **Skill tool** with name `agent-workflow` to load full coordination instructions.
The skill is at `.claude/skills/agent-workflow/SKILL.md`.

---

## CLI Quick Reference

```bash
# Setup workspace
./gradlew :cli:run --args="setup -w ./examples/sample-test"

# Run a pipeline
./gradlew :cli:run --args="run -p sample-pipeline -w ./examples/sample-test"

# Run with builtin tools enabled
./gradlew :cli:run --args="setup -w ./" -PbuiltinToolsEnabled=true
```

See `docs/cli-commands.md` for full reference.

---

## Critical Rules

- NEVER delete or rewrite working tests unless explicitly requested.
- NEVER delete files without explicit confirmation.
- ALWAYS run `./gradlew spotlessApply` before running tests.
- ALWAYS run relevant tests after each code change.
- ALWAYS run the full test suite (`./gradlew test`) before handoff or commit.
- Work on one scoped change at a time; avoid unrelated refactors.
- If unsure, ask instead of guessing.

---

## Working Style

- Plan first, then implement — use `planner` agent for anything non-trivial.
- Prefer small diffs: one scoped change + tests, then the next.
- Use the **agent-workflow skill** for complex tasks (Skill tool → `agent-workflow`).
- Agent sequence for complex tasks: `planner` → implement → `code-reviewer` → `tester`.
- Follow the overall course and intent defined in `docs/tdd.md`.
