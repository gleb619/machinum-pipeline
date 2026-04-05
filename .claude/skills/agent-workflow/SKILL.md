---
name: agent-workflow
description: Coordinate development workflow using Machinum Pipeline's agent system (planner, code-reviewer, tester). Use when planning development, reviewing code, or managing TDD process.
---

# Agent Workflow Skill

## Instructions

Follow the Machinum Pipeline's agent-based development workflow to ensure quality, TDD compliance, and proper
coordination.

### Agent System Overview

The project uses three specialized agents with defined responsibilities:

- **Planner** (`.claude/agents/planner.md`) - Creates implementation plans
- **Code Reviewer** (`.claude/agents/code-reviewer.md`) - Reviews for quality and compliance
- **Tester** (`.claude/agents/tester.md`) - Verifies TDD compliance and test coverage

### Agent Responsibilities

#### Planner Agent

**Role**: Create step-by-step implementation plans with TDD requirements

**Responsibilities**:

1. Research the codebase and existing tests before proposing changes
2. Produce step-by-step implementation plans with impacted files
3. Identify risks, edge cases, and backward compatibility concerns
4. Flag files or components that should not be modified
5. NEVER write code; planning only

**Key Requirements**:

- All implementation plans MUST enforce TDD (Test-Driven Development)
- Red: define failing tests first for each behavior change
- Green: define minimal implementation steps to satisfy tests
- Refactor: define cleanup steps that keep tests green

**Usage**: When starting new features or significant changes

#### Code Reviewer Agent

**Role**: Review guidance for quality, regressions, and TDD compliance

**Responsibilities**:

1. Regressions: do changes break existing functionality?
2. Security: secrets exposure, auth bypass, injection risks, unsafe input handling
3. Quality: error handling, readability, maintainability, unnecessary complexity
4. Patterns: does new code follow conventions from `CLAUDE.md` and `docs/tdd.md`?
5. Tests: is coverage adequate and aligned with TDD expectations?

**Key Requirements**:

- All development MUST go through TDD (Test-Driven Development)
- During review, verify evidence of red → green → refactor for behavior changes
- Output severity-rated findings with precise `file:line` references
- Ensure feedback follows the course set by `docs/tdd.md`

**Usage**: Before merging code or completing implementation

#### Tester Agent

**Role**: Testing guidance focused on regression prevention and TDD compliance

**Responsibilities**:

1. Follow existing test patterns and conventions
2. Add or adjust tests for changed behavior
3. Run relevant tests during iteration and full suite before final handoff
4. Report pass/fail status and likely regression impact

**Key Requirements**:

- Verify red: failing tests exist for each behavior change
- Verify green: implementation makes those tests pass
- Verify refactor: test suite remains green after cleanup
- ALWAYS run the full test suite before completion
- Do NOT modify or delete existing passing tests unless explicitly asked
- Do NOT skip failing tests; report failures with clear `file:line` references

**Usage**: During development and before completion

### Workflow Coordination

#### 1. Planning Phase

```
User Request → Planner Agent → Implementation Plan
```

**Process**:

1. User requests feature or change
2. Planner agent researches codebase
3. Creates detailed plan with TDD requirements
4. Plan includes file impacts and risks
5. Plan saved to `.windsurf/plans/`

#### 2. Development Phase

```
Plan → Implementation → Continuous Testing
```

**Process**:

1. Developer follows planner's TDD-based plan
2. Red: Write failing tests first
3. Green: Implement minimal code to pass tests
4. Refactor: Clean up while keeping tests green
5. Tester agent verifies TDD compliance continuously

#### 3. Review Phase

```
Implementation → Code Reviewer Agent → Quality Assessment
```

**Process**:

1. Code reviewer analyzes implementation
2. Checks for regressions, security, quality
3. Verifies TDD evidence and patterns
4. Provides severity-rated findings with `file:line` references
5. Ensures compliance with `docs/tdd.md` direction

#### 4. Completion Phase

```
Review + Testing → Final Validation → Completion
```

**Process**:

1. All agent feedback addressed
2. Full test suite passes
3. Documentation updated
4. Ready for merge/deployment

### Agent Interaction Patterns

#### Planner → Developer

- Provides detailed implementation steps
- Identifies files to modify and avoid
- Sets TDD requirements for each step
- Highlights risks and dependencies

#### Developer → Tester

- Provides code for continuous validation
- Reports test results and issues
- Implements fixes based on feedback
- Maintains TDD workflow

#### Developer → Code Reviewer

- Submits implementation for quality review
- Addresses findings and recommendations
- Ensures compliance with project standards

#### Tester → Developer

- Validates TDD compliance
- Reports test failures with precise locations
- Suggests test improvements
- Confirms regression prevention

### Agent Activation Triggers

**Use Planner Agent When**:

- Starting new features or components
- Making significant architectural changes
- Needing research and planning
- Complex integrations required

**Use Code Reviewer Agent When**:

- Completing implementation
- Before merging code changes
- Quality assurance needed
- Security review required

**Use Tester Agent When**:

- Writing or modifying tests
- Validating TDD compliance
- Running test suites
- Checking for regressions

### Quality Gates

Each agent enforces specific quality gates:

**Planner Gates**:

- [ ] Research completed
- [ ] TDD requirements defined
- [ ] File impacts identified
- [ ] Risks assessed
- [ ] Plan documented

**Code Reviewer Gates**:

- [ ] No regressions detected
- [ ] Security issues addressed
- [ ] Quality standards met
- [ ] Patterns followed correctly
- [ ] TDD evidence verified

**Tester Gates**:

- [ ] Red phase: Failing tests exist
- [ ] Green phase: Tests pass
- [ ] Refactor phase: Tests remain green
- [ ] Full suite passes
- [ ] No regressions introduced

### Common Workflows

#### Feature Development Workflow

1. **Planner**: Create implementation plan with TDD steps
2. **Developer**: Implement following red-green-refactor
3. **Tester**: Continuous validation and test coverage
4. **Code Reviewer**: Quality and compliance review
5. **Tester**: Final full test suite validation
6. **Completion**: All gates passed

#### Bug Fix Workflow

1. **Planner**: Analyze bug and create fix plan
2. **Developer**: Write failing test for bug
3. **Developer**: Implement minimal fix
4. **Tester**: Verify fix and no regressions
5. **Code Reviewer**: Review fix quality
6. **Tester**: Full regression test

#### Refactoring Workflow

1. **Planner**: Plan refactoring with safety measures
2. **Developer**: Ensure all tests pass before starting
3. **Developer**: Refactor incrementally
4. **Tester**: Validate tests remain green
5. **Code Reviewer**: Review refactoring quality
6. **Tester**: Full regression test

## Templates

Use templates in `templates/` directory for agent coordination.

## Examples

See `examples/` directory for workflow scenarios.

## References

- `.claude/agents/planner.md` - Planning guidance
- `.claude/agents/code-reviewer.md` - Review criteria
- `.claude/agents/tester.md` - Testing requirements
- `docs/tdd.md` - Technical design and TDD principles
