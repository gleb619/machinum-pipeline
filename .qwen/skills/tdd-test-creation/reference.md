# TDD Reference Guide

## Agent Responsibilities

### Tester Agent (`.claude/agents/tester.md`)

- Follow existing test patterns and conventions
- Add or adjust tests for changed behavior
- Run relevant tests during iteration and full suite before final handoff
- Report pass/fail status and likely regression impact

### Rules from Tester Agent

- ALWAYS run the full test suite before completion
- Do NOT modify or delete existing passing tests unless explicitly asked
- Do NOT skip failing tests; report failures with clear `file:line` references

## TDD in Technical Design Document

From `docs/tdd.md:15-17`:

```
All development MUST go through TDD (Test-Driven Development):
- Red: define failing tests first for each behavior change.
- Green: define minimal implementation steps to satisfy tests.
- Refactor: define cleanup steps that keep tests green.
```

## Test Discovery Patterns

Look for existing tests in:

- `cli/src/test/java/machinum/cli/` - CLI command tests
- `core/src/test/java/machinum/` - Core component tests
- `server/src/test/java/machinum/server/` - Server tests

## Common Test Libraries

- JUnit 5 for test framework
- AssertJ for fluent assertions
- Mockito for mocking (when needed)
- JUnit TempDir for file system tests
