# CLAUDE.md

Before starting work, read `docs/tdd.md`.

Treat `docs/tdd.md` as a high-level design guide, not an implementation document.
Code structure, APIs, and names do not need exact 1:1 matching.

## Mandatory development process (TDD)
- All development MUST go through TDD (Test-Driven Development).
- Follow red → green → refactor for each behavior change:
  1. Add or update a test that fails for the target behavior.
  2. Implement the minimal code needed to make the test pass.
  3. Refactor while keeping tests green.
- Do not start implementation before a failing test exists unless the task is explicitly non-code.

## Critical rules
- NEVER delete or rewrite working tests unless explicitly requested.
- NEVER delete files without explicit confirmation.
- ALWAYS run relevant tests after each code change.
- ALWAYS run the full test suite before handoff or commit.
- Work on one scoped change at a time; avoid unrelated refactors.
- If unsure, ask instead of guessing.

## Working style
- Plan first, then implement.
- Prefer small diffs: one scoped change + tests, then the next.
- Use agent sequence for complex tasks: `planner` → implement → `code-reviewer` → `tester`.

Follow the overall course and intent defined in `docs/tdd.md`.
