# Universal Project Rules

**Always active** — core development standards for Machinum Pipeline.

## Mandatory TDD Workflow

All development MUST follow Test-Driven Development:

1. **Red**: Write/update failing test for each behavior change
2. **Green**: Implement minimal code to make test pass
3. **Refactor**: Clean up while keeping tests green

**Never start implementation before a failing test exists** (unless explicitly non-code task).

## Critical Rules

- **NEVER** delete or rewrite working tests unless explicitly requested
- **NEVER** delete files without explicit confirmation
- **ALWAYS** run relevant tests after each code change
- **ALWAYS** run full test suite before handoff or commit
- Work on one scoped change at a time; avoid unrelated refactors
- If unsure, ask instead of guessing

## Working Style

- Plan first, then implement
- Prefer small diffs: one scoped change + tests, then next
- Follow agent sequence for complex tasks: `planner` → implement → `code-reviewer` → `tester`

## Tech Stack

- **Language**: Java 25
- **Build**: Gradle 9.4.1
- **CLI**: Picocli 4.7+
- **YAML**: SnakeYAML 2.0+
- **JSON**: Jackson 3.1+
- **Scripting**: Groovy 4.0+
- **Logging**: SLF4J + Logback

## Design Guidance

Reference `docs/tdd.md` for high-level design direction. Code structure, APIs, and names do not need exact 1:1 matching.
