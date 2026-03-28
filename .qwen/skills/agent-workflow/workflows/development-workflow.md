# Development Workflow Examples

## Feature Development Workflow

### Step 1: Planning Phase

**Agent**: Planner
**Trigger**: New feature request

```
User: "Add a new CLI command for pipeline cleanup"

Planner Agent Actions:
1. Research existing CLI commands (HelpCommand.java, etc.)
2. Analyze cleanup requirements from docs/tdd.md
3. Create TDD-based implementation plan
4. Identify files to modify: cli/, core/, tests/
5. Document risks and dependencies
6. Save plan to /home/boris/.windsurf/plans/
```

**Output**: Implementation plan with red-green-refactor steps

### Step 2: Development Phase

**Agent**: Developer + Tester
**Process**: TDD implementation

```
Developer Actions (Red Phase):
1. Write failing test for CleanupCommand
2. Test should verify command registration and basic functionality
3. Run test - confirm it fails

Tester Agent Validation:
- Verify test follows existing patterns
- Confirm test is properly failing
- Check test coverage requirements

Developer Actions (Green Phase):
1. Implement minimal CleanupCommand class
2. Add command to MachinumCli registration
3. Run test - confirm it passes

Tester Agent Validation:
- Verify implementation is minimal
- Confirm tests now pass
- Check no unnecessary complexity

Developer Actions (Refactor Phase):
1. Improve code quality and readability
2. Extract reusable components
3. Add proper error handling
4. Run tests - confirm they still pass

Tester Agent Validation:
- Verify tests remain green after refactoring
- Check code quality improvements
- Validate TDD compliance
```

### Step 3: Code Review Phase

**Agent**: Code Reviewer
**Trigger**: Implementation complete

```
Code Reviewer Analysis:
1. Regressions: Does cleanup command break existing CLI?
2. Security: Any command injection risks?
3. Quality: Error handling, readability, maintainability
4. Patterns: Follows HelpCommand.java patterns?
5. Tests: Adequate coverage and TDD evidence?

Output: Severity-rated findings with file:line references
```

### Step 4: Final Validation

**Agent**: Tester
**Trigger**: Code review complete

```
Tester Final Actions:
1. Run full test suite
2. Verify no regressions
3. Validate TDD workflow evidence
4. Confirm test coverage
5. Report final status
```

## Bug Fix Workflow

### Example: Pipeline State Not Persisting

```
1. Planner Agent:
   - Analyze checkpointing code in core/
   - Identify root cause in state persistence
   - Create fix plan with regression tests

2. Developer (Red):
   - Write test that reproduces the bug
   - Test should fail before fix

3. Developer (Green):
   - Implement minimal fix for state persistence
   - Make test pass

4. Tester:
   - Verify fix works
   - Run regression tests
   - Check no new issues

5. Code Reviewer:
   - Review fix quality
   - Check for side effects
   - Validate error handling

6. Tester:
   - Full regression test
   - Confirm bug fixed
   - Validate no regressions
```

## Refactoring Workflow

### Example: Extract Common CLI Logic

```
1. Planner Agent:
   - Analyze existing CLI commands
   - Identify common patterns
   - Plan safe refactoring steps
   - Define test safety nets

2. Developer (Pre-refactor):
   - Ensure all tests pass
   - Add integration tests if needed
   - Create refactoring safety net

3. Developer (Refactor):
   - Extract base class for CLI commands
   - Move common logic to base class
   - Update existing commands to use base
   - Run tests after each change

4. Tester:
   - Continuous validation during refactoring
   - Ensure tests remain green
   - Verify no behavior changes

5. Code Reviewer:
   - Review refactoring quality
   - Check design improvements
   - Validate maintainability

6. Tester:
   - Full regression test
   - Performance validation
   - Confirm refactoring success
```

## Agent Coordination Patterns

### Parallel Validation

```
Developer implements → Tester validates TDD → Code Reviewer checks quality
                      ↘ Continuous testing ↗
```

### Sequential Gates

```
Plan → Implement → Review → Test → Complete
  ↓        ↓         ↓       ↓        ↓
Planner  Developer  CodeRev  Tester  All Gates Pass
```

### Feedback Loops

```
Code Reviewer findings → Developer fixes → Tester re-validates
        ↖-----------------------------------↙
```

## Quality Gates Checklist

### Planner Gates

- [ ] Research completed and documented
- [ ] TDD requirements clearly defined
- [ ] File impacts and risks identified
- [ ] Dependencies analyzed
- [ ] Plan saved and accessible

### Developer Gates

- [ ] Red phase: Failing tests written first
- [ ] Green phase: Minimal implementation
- [ ] Refactor phase: Quality improvements
- [ ] Tests pass after each phase
- [ ] Code follows project patterns

### Tester Gates

- [ ] TDD compliance verified
- [ ] Test coverage adequate
- [ ] No regressions detected
- [ ] Full test suite passes
- [ ] Findings documented with file:line

### Code Reviewer Gates

- [ ] No security vulnerabilities
- [ ] Quality standards met
- [ ] Patterns followed correctly
- [ ] Documentation updated
- [ ] Ready for production

## Escalation Paths

### Blocker Issues

```
Developer → Tester → Code Reviewer → Planner → Manual Review
```

### Quality Concerns

```
Code Reviewer → Developer → Tester → Re-review
```

### TDD Violations

```
Tester → Developer → Re-implementation → Re-validation
```
