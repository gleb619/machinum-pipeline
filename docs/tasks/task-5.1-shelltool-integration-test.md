# Task: 5.1-shelltool-integration-test

**Phase**: 5
**Priority**: P0
**Status**: `completed`
**Depends On**: Task 1.2 (ShellTool implementation)
**TDD Reference**: `docs/tdd.md` section 5.1

---

## Description

Create comprehensive integration tests for `ShellTool` to verify shell script execution with JSON I/O, timeout
enforcement, exit code handling, and environment variable injection. These tests ensure the ShellTool works correctly
with real shell scripts in a controlled test environment.

---

## Acceptance Criteria

- [x] Test script created in `tools/external/src/test/resources/scripts/` directory
- [x] Test verifies script executes with correct JSON input via stdin
- [x] Test verifies JSON output is correctly parsed from stdout
- [x] Test verifies timeout enforcement (script killed after timeout)
- [x] Test verifies exit code handling (non-zero exit = failure)
- [x] Test verifies environment variable injection from config
- [x] Test verifies working directory is set correctly
- [x] Test verifies error output (stderr) is logged for debugging
- [x] All tests pass consistently on Linux and macOS

---

## Implementation Notes

### Test Script Examples

Create test scripts in `tools/external/src/test/resources/scripts/`:

**1. echo_input.sh** - Echoes JSON input back (basic test):

```bash
#!/bin/bash
cat stdin  # Read JSON from stdin
```

**2. transform.sh** - Transforms JSON input:

```bash
#!/bin/bash
# Read JSON, add a field, output
input=$(cat)
echo "$input" | jq '. + {"processed": true, "timestamp": "'$(date -Iseconds)'"}'
```

**3. exit_code.sh** - Returns specific exit code:

```bash
#!/bin/bash
exit ${1:-0}  # Exit with provided code or 0
```

**4. slow_script.sh** - For timeout testing:

```bash
#!/bin/bash
sleep ${1:-10}  # Sleep for provided seconds or 10
echo '{"status": "completed"}'
```

**5. use_env.sh** - Uses environment variables:

```bash
#!/bin/bash
echo "{\"env_var\": \"$TEST_VAR\", \"home\": \"$HOME\"}"
```

### Test Class Structure

```java
package machinum.tool;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.Map;
import machinum.pipeline.ExecutionContext;
import machinum.manifest.PipelineToolManifest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ShellToolTest {

  @TempDir
  Path tempDir;

  private ObjectMapper objectMapper;
  private Path scriptDir;

  @BeforeEach
  void setUp() {
    objectMapper = new ObjectMapper();
    scriptDir = Paths.get("core/src/test/resources/scripts");
  }

  @Test
  void testExecuteWithJsonInput() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("echo_input.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("echo_input.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("item", Map.of("id", "test-123", "content", "Hello"))
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("test-123", result.outputs().get("id"));
  }

  @Test
  void testExecuteWithTimeout() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("slow_script.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("slow_script.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(1))  // 1 second timeout
        .args(List.of("10"))  // Try to sleep for 10 seconds
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = ExecutionContext.builder().build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("timed out"));
  }

  @Test
  void testExecuteWithNonZeroExitCode() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("exit_code.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("exit_code.sh"))
        .workDir(tempDir)
        .args(List.of("1"))  // Exit with code 1
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = ExecutionContext.builder().build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("exit code"));
  }

  @Test
  void testExecuteWithEnvironmentVariables() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("use_env.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("use_env.sh"))
        .workDir(tempDir)
        .environment(Map.of("TEST_VAR", "test-value"))
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = ExecutionContext.builder().build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("test-value", result.outputs().get("env_var"));
  }

  @Test
  void testExecuteWithTransform() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("transform.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("transform.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("item", Map.of("id", "test-1", "value", "original"))
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertTrue((Boolean) result.outputs().get("processed"));
    assertEquals("original", result.outputs().get("value"));
  }
}
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` section 5.1 - External Tools
- **ShellTool Implementation**: `tools/external/src/main/java/machinum/tool/ShellTool.java`
- **ExternalTool Base**: `tools/common/src/main/java/machinum/tool/ExternalTool.java`

**Files to Create**:

- `tools/external/src/test/java/machinum/tool/ShellToolTest.java`
- `tools/external/test/resources/scripts/echo_input.sh`
- `tools/external/test/resources/scripts/transform.sh`
- `tools/external/test/resources/scripts/exit_code.sh`
- `tools/external/test/resources/scripts/slow_script.sh`
- `tools/external/test/resources/scripts/use_env.sh`

**Files to Read**:

- `tools/external/src/main/java/machinum/tool/ShellTool.java` (lines 1-212)
- `core/src/test/java/machinum/expression/DefaultExpressionResolverTest.java` - Test style reference

---

## Spec

### Contracts

**ShellTool Builder**:

```java
ShellTool.builder()
    .

definition(ToolDefinition)
    .

scriptPath(Path)
    .

workDir(Path)
    .

timeout(Duration)
    .

args(List<String>)
    .

environment(Map<String, String>)
    .

interpreter(String)  // Optional, default: "bash"
    .

objectMapper(ObjectMapper)
    .

build();
```

**ToolResult**:

```java
Tool.ToolResult.success(Map<String, Object> outputs)
Tool.ToolResult.

failure(String errorMessage)
```

### Data Model

**Test Script Requirements**:

- Must be executable (`chmod +x`)
- Must read JSON from stdin
- Must output valid JSON to stdout
- Must exit with code 0 for success, non-zero for failure

**Test ExecutionContext**:

```java
ExecutionContext.builder()
    .

put("item",Map)       // Current item being processed
    .

put("text",String)    // Current text content
    .

put("runId",String)   // Run identifier
    .

build();
```

### Checklists

**Verification Commands**:

```bash
# Make test scripts executable
chmod +x tools/external/src/test/resources/scripts/*.sh

# Run ShellTool integration tests
./gradlew :core:test --tests "*ShellToolTest*"

# Run with verbose output
./gradlew :core:test --tests "*ShellToolTest*" --info

# Verify script permissions
ls -la tools/external/src/test/resources/scripts/
```

### Plan

1. **Create test scripts** in `tools/external/src/test/resources/scripts/`
2. **Make scripts executable** with `chmod +x`
3. **Create test class** `ShellToolTest.java`
4. **Implement basic execution test** (echo input)
5. **Implement timeout test** (slow script)
6. **Implement exit code test** (non-zero exit)
7. **Implement environment variable test**
8. **Implement transform test** (JSON transformation)
9. **Run all tests** and fix any issues
10. **Verify cross-platform compatibility** (Linux/macOS)

### Quickstart

- `tools/external/src/main/java/machinum/tool/ShellTool.java` - Tool implementation
- `tools/external/src/test/resources/scripts/` - Directory for test scripts
- `core/src/test/java/machinum/expression/DefaultExpressionResolverTest.java` - Test style reference

---

## TDD Approach

### 1. Create Test Scripts First

Create minimal shell scripts that test specific behaviors:

- Basic I/O
- Timeout
- Exit codes
- Environment variables

### 2. Write Failing Tests

Write tests that will fail initially (e.g., script not found, wrong output format)

### 3. Make Tests Pass

Ensure ShellTool correctly executes scripts and handles all scenarios

### 4. Refine and Extend

- Add edge case tests (empty input, large JSON, special characters)
- Add performance tests (concurrent executions)
- Add error handling tests (missing script, invalid JSON output)

---

## Result

Link to: `docs/results/5.1-shelltool-integration-test.result.md`
