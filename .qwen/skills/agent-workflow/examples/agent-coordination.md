# Agent Coordination Examples

## Example 1: New CLI Command Development

### Scenario

User requests: "Add a `status` command to show pipeline run status"

### Agent Coordination Flow

#### Step 1: Planner Agent Analysis

```
Planner Research:
- Existing commands: HelpCommand.java (cli/src/main/java/machinum/cli/commands/)
- Test patterns: HelpCommandTest.java (cli/src/test/java/machinum/cli/)
- Status requirements: docs/tdd.md checkpointing section
- Files to modify: cli/src/main/java/machinum/cli/MachinumCli.java

Planner Output:
- Red: Write StatusCommandTest first
- Green: Implement StatusCommand with Picocli
- Refactor: Extract common command patterns
- Risk: CLI registration conflicts
```

#### Step 2: Developer Implementation with Tester Validation

```
Developer (Red Phase):
- Creates StatusCommandTest.java
- Tests command registration and basic output
- Test fails (StatusCommand doesn't exist)

Tester Validation:
- Confirms test follows HelpCommandTest.java pattern
- Verifies test properly fails
- Checks test covers main scenarios

Developer (Green Phase):
- Implements StatusCommand.java
- Follows HelpCommand.java structure
- Registers command in MachinumCli.java
- Test now passes

Tester Validation:
- Confirms minimal implementation
- Verifies no unnecessary complexity
- Validates TDD compliance

Developer (Refactor Phase):
- Extracts common CLI patterns to base class
- Improves error handling
- Enhances output formatting
- Tests still pass

Tester Validation:
- Ensures tests remain green
- Validates refactoring quality
- Confirms no regressions
```

#### Step 3: Code Reviewer Assessment

```
Code Reviewer Analysis:
- Regressions: CLI still works, help command unaffected
- Security: Command injection risks in status parsing
- Quality: Error handling needs improvement
- Patterns: Follows established CLI conventions
- Tests: Good coverage, TDD evidence clear

Findings:
- MEDIUM: Add input validation for status IDs (StatusCommand.java:45)
- LOW: Extract common help text pattern (StatusCommand.java:23)
- INFO: Good TDD workflow evidence
```

#### Step 4: Final Resolution

```
Developer Actions:
- Fix security finding (input validation)
- Implement low priority improvement
- Re-run tests

Tester Final Validation:
- Full test suite passes
- No regressions detected
- TDD compliance maintained
- Ready for completion
```

## Example 2: YAML Configuration Bug Fix

### Scenario

Bug report: "Pipeline YAML fails to load with nested variables"

### Agent Coordination Flow

#### Step 1: Planner Agent Investigation

```
Planner Research:
- YAML loading: core/src/main/java/machinum/yaml/
- Variable resolution: docs/tdd.md expression section
- Test files: core/src/test/java/machinum/yaml/
- Root cause: Variable resolution doesn't handle nested expressions

Planner Plan:
- Red: Write test for nested variable resolution
- Green: Fix expression resolver
- Refactor: Improve error messages and performance
- Risk: Break existing variable resolution
```

#### Step 2: Implementation with Continuous Testing

```
Developer (Red):
- Creates failing test for nested variables like "{{{{env.{{VAR}}}}}}"
- Test reproduces user's bug report
- Test fails with current implementation

Tester Validation:
- Confirms test accurately reproduces bug
- Verifies test follows existing YAML test patterns
- Checks test covers edge cases

Developer (Green):
- Modifies ExpressionResolver to handle nesting
- Adds proper parsing logic
- Test now passes

Tester Validation:
- Verifies fix is minimal and focused
- Confirms no side effects
- Validates performance impact acceptable

Developer (Refactor):
- Improves error messages for invalid nesting
- Adds performance optimizations
- Enhances test coverage
- Tests remain green
```

#### Step 3: Code Review and Validation

```
Code Reviewer Findings:
- Regressions: None detected in existing variable tests
- Security: No injection risks in expression parsing
- Quality: Good error handling, could be more descriptive
- Patterns: Follows existing resolver patterns
- Tests: Comprehensive coverage

Tester Final:
- Full YAML test suite passes
- Variable resolution regression tests pass
- Performance benchmarks acceptable
- Bug fix validated
```

## Example 3: Agent Conflict Resolution

### Scenario

Code Reviewer and Tester disagree on implementation approach

### Conflict: Status Command Output Format

```
Code Reviewer: "Should use JSON format for consistency with other tools"
Tester: "Should use human-readable format for better UX"

Resolution Process:
1. Developer presents both options with pros/cons
2. Refer to docs/tdd.md for CLI patterns
3. Check existing commands (HelpCommand.java) for precedent
4. Decision: Follow existing help command pattern (human-readable)
5. Document decision for future reference
```

### Escalation Path

```
Level 1: Developer attempts resolution
Level 2: Reference project documentation (docs/tdd.md, CLAUDE.md)
Level 3: Check existing patterns in codebase
Level 4: Architectural decision documented
Level 5: Manual review if needed
```

## Example 4: Multi-Agent Parallel Workflow

### Scenario: Complex Feature with Multiple Components

### Feature: External Tool Integration

```
Parallel Agent Activities:

Planner Agent:
- Creates comprehensive plan
- Identifies core/, cli/, server/ impacts
- Defines integration points

Developer (Core Module):
- Implements tool registry
- Adds external tool execution
- Follows TDD workflow

Developer (CLI Module):
- Adds install command
- Implements tool management
- Follows TDD workflow

Tester (Continuous):
- Validates core module TDD
- Validates CLI module TDD
- Runs integration tests
- Checks cross-module compatibility

Code Reviewer (Staged):
- Reviews core implementation
- Reviews CLI implementation
- Validates integration points
- Checks overall architecture
```

### Coordination Benefits

- Parallel development speeds up delivery
- Continuous testing catches issues early
- Staged reviews ensure quality
- Clear agent responsibilities prevent conflicts

## Communication Patterns

### Agent-to-Agent Messages

```
Planner → Developer: "Implementation plan ready, focus on TDD steps"
Developer → Tester: "Red phase complete, please validate failing test"
Tester → Developer: "Test fails correctly, proceed to green phase"
Code Reviewer → Developer: "Review complete, see findings at file:line"
Developer → All: "Fixes implemented, ready for re-validation"
```

### Status Updates

```
Agent: Developer
Phase: Green
Status: StatusCommand implementation complete
Tests: Passing
Next: Code review requested

Agent: Tester
Phase: Validation
Status: TDD compliance verified
Regression: None detected
Ready: Final validation
```

## Best Practices

### Clear Handoffs

- Document phase completion
- Specify next agent responsibilities
- Provide context and requirements
- Include test results and findings

### Conflict Prevention

- Reference project documentation early
- Follow existing patterns consistently
- Communicate assumptions clearly
- Document decisions for future reference

### Quality Assurance

- Each agent enforces specific quality gates
- Continuous validation prevents issues
- Regression testing ensures stability
- Documentation maintains consistency
