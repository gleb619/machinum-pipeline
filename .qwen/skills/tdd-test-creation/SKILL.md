---
name: tdd-test-creation
description: Create tests following Test-Driven Development principles for Machinum Pipeline. Use when writing tests, implementing features, or following TDD workflow.
---

# TDD Test Creation Skill

## Instructions

Follow strict Test-Driven Development (TDD) workflow as defined in `docs/tdd.md` and enforced by the project's agent
system.

### TDD Workflow: Red → Green → Refactor

**1. RED Phase**: Write failing tests first

- Create test that fails for the behavior you want to implement
- Test must fail before implementation exists
- Follow existing test patterns in the project

**2. GREEN Phase**: Make minimal implementation

- Write just enough code to make tests pass
- No extra features or optimizations
- Keep implementation simple and focused

**3. REFACTOR Phase**: Clean up while keeping tests green

- Improve code quality, readability, maintainability
- Ensure all tests remain passing
- Follow project conventions from `CLAUDE.md`

### Test Structure Patterns

#### Unit Tests

```java
package machinum.[module];

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;

/** Test for [ClassName]. */
class ClassNameTest {

  private ClassName className;

  @BeforeEach
  void setUp() {
    // Arrange: Set up test fixtures
    className = new ClassName();
  }

  @Test
  void testBehavior() {
    // Act: Execute the behavior being tested
    var result = className.method();

    // Assert: Verify expected outcome
    assertEquals("expected", result);
  }
}
```

#### Integration Tests

```java
package machinum.[module];

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;

/** Integration test for [Feature]. */
class FeatureIntegrationTest {

  @TempDir
  Path tempDir;

  @Test
  void testEndToEndFlow() {
    // Test complete workflow with real file system
    // Follow patterns from existing integration tests
  }
}
```

### Test Requirements

**Mandatory TDD Compliance**:

- All development MUST go through TDD (`docs/tdd.md:15-17`)
- Verify red: failing tests exist for each behavior change
- Verify green: implementation makes those tests pass
- Verify refactor: test suite remains green after cleanup

**Test Coverage**:

- Unit tests for individual components
- Integration tests for user stories
- Follow existing test patterns and conventions
- Add or adjust tests for changed behavior

**Test Execution**:

- Run relevant tests during iteration
- Run full test suite before completion
- Report pass/fail status with clear `file:line` references

### Agent Coordination

Follow the project's agent workflow:

1. **Planner**: Creates step-by-step implementation plans with TDD requirements
2. **Developer**: Implements following red-green-refactor workflow
3. **Tester**: Verifies TDD compliance and test coverage
4. **Code Reviewer**: Ensures TDD evidence and quality standards

### Common Test Patterns

#### CLI Command Tests

Follow `HelpCommandTest.java:12-19` pattern:

```java
@Test
void testHelpCommand() {
  MachinumCli cli = new MachinumCli();
  CommandLine commandLine = new CommandLine(cli);
  
  int exitCode = commandLine.execute("help");
  
  assertEquals(0, exitCode, "Help command should succeed");
}
```

#### YAML Configuration Tests

Test loading and validation following `docs/tdd.md:79-445` schema.

#### Pipeline Execution Tests

Test state machine and tool execution patterns.

### Rules

- ALWAYS run the full test suite before completion
- Do NOT modify or delete existing passing tests unless explicitly asked
- Do NOT skip failing tests; report failures with clear `file:line` references
- Test work following the course defined in `docs/tdd.md`

## References

- `docs/tdd.md` - Technical design and TDD requirements
- `.claude/agents/tester.md` - Testing guidance and responsibilities
- Existing test files for patterns and conventions
- `docs/plan.md` for task dependencies and priorities
