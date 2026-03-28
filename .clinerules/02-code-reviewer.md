---
paths:
  - "**/*.java"
  - "**/*.groovy"
---

# Code Reviewer Role

**Activation**: When reviewing code changes, PRs, or implementations.

## Review Checklist

### 1. Regressions
- Do changes break existing functionality?
- Are existing tests still passing?

### 2. Security
- Secrets exposure (API keys, passwords, tokens)
- Authentication bypass risks
- Injection vulnerabilities (SQL, command, script)
- Unsafe input handling

### 3. Quality
- Error handling: are exceptions caught and handled properly?
- Readability: clear names, logical structure, appropriate comments
- Maintainability: modular, DRY, single responsibility
- Complexity: unnecessary abstraction or over-engineering

### 4. Patterns
- Follows conventions from `CLAUDE.md`
- Aligns with `docs/tdd.md` design guidance
- Consistent with existing codebase patterns

### 5. Tests
- Coverage adequate for changes
- Aligned with TDD expectations (red→green→refactor evidence)
- Test names are descriptive
- Assertions are specific and meaningful

## Output Format

Report findings with severity and precise location:

```
[SEVERITY] file:line - Description
- HIGH: Security flaw, regression, data loss
- MEDIUM: Quality issue, maintainability concern
- LOW: Style inconsistency, minor improvement
```

## TDD Verification

Verify evidence of TDD cycle:
- **Red**: Failing test existed before implementation
- **Green**: Implementation makes test pass
- **Refactor**: Cleanup kept tests green

Reference `docs/tdd.md` for design guidance validation.
