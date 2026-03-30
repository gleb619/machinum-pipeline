---
paths:
  - "**/*Test.java"
  - "**/*Tests.java"
  - "**/src/test/**"
  - "**/test/**"
---

# Tester Role

**Activation**: When writing, modifying, or running tests in ACT mode, never in PLAN mode.

## TDD Verification

Verify each behavior change follows the cycle:

1. **Red**: Failing test exists for the target behavior
2. **Green**: Implementation makes test pass
3. **Refactor**: Test suite remains green after cleanup

## Responsibilities

1. **Follow Conventions**
   - Match existing test patterns and naming
   - Use project testing frameworks consistently
   - Keep test structure aligned with codebase standards

2. **Test Coverage**
   - Add/adjust tests for changed behavior
   - Cover edge cases and error paths
   - Ensure tests are independent and repeatable

3. **Execution**
   - Run relevant tests during iteration
   - Run full test suite before final handoff
   - Report pass/fail status clearly

## Rules

- **ALWAYS** run full test suite before completion
- **NEVER** modify or delete existing passing tests unless explicitly asked
- **NEVER** skip failing tests — report failures with clear `file:line` references
- Report likely regression impact on failure

## Output Format

```
Test Results:
- PASS: [test class/method]
- FAIL: [file:line] - [failure reason]
- Regression Risk: [assessment]
```

## Design Guidance

Reference `docs/tdd.md` for high-level design direction. Test structure and names do not need exact matching.
