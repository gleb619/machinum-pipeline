# Task: 5.2-groovyscripttool-integration-test

**Phase**: 5
**Priority**: P0
**Status**: `pending`
**Depends On**: Task 1.3 (GroovyScriptTool implementation)
**TDD Reference**: `docs/tdd.md` section 5.1

---

## Description

Create comprehensive integration tests for `GroovyScriptTool` to verify Groovy script execution with context binding,
return type validation, security sandbox, and script caching. These tests ensure the GroovyScriptTool works correctly
with real Groovy scripts for conditions, transformers, and validators.

---

## Acceptance Criteria

- [x] Test scripts created in `core/src/test/resources/scripts/` for conditions, transformers, validators
- [x] Test verifies binding is populated correctly with all context variables
- [x] Test verifies return type validation (Boolean for conditions, Map for transformers)
- [x] Test verifies script caching (same script executed twice uses cached version)
- [x] Test verifies timeout enforcement for long-running scripts
- [x] Test verifies error handling for script compilation failures
- [x] Test verifies environment variables accessible via `env.VARIABLE_NAME`
- [x] Test verifies pipeline variables accessible in binding
- [x] All tests pass consistently

---

## Implementation Notes

### Test Script Examples

Create test scripts in `core/src/test/resources/scripts/`:

**1. conditions/is_valid.groovy** - Simple condition check:

```groovy
// Returns true if text is not null and not empty
return text != null && !text.isEmpty()
```

**2. conditions/type_check.groovy** - Type-based condition:

```groovy
// Check if item type matches expected type
return item?.type == 'chapter'
```

**3. transformers/uppercase.groovy** - Text transformation:

```groovy
// Convert text to uppercase
return [result: text.toUpperCase(), original: text]
```

**4. transformers/extract_metadata.groovy** - Extract metadata from item:

```groovy
// Extract and transform metadata
def metadata = [
    id       : item.id,
    type     : item.type,
    length   : text?.length() ?: 0,
    processed: true
]
return metadata
```

**5. validators/has_content.groovy** - Content validation:

```groovy
// Validate that item has required content field
return item?.containsKey('content') && item.content != null
```

**6. validators/json_structure.groovy** - JSON structure validation:

```groovy
// Validate JSON structure
if (!(item instanceof Map)) {
  return [valid: false, error: 'Item must be a Map']
}
def requiredFields = ['id', 'type']
def missing = requiredFields.findAll {!item.containsKey(it)}
if (missing) {
  return [valid: false, error: "Missing fields: ${missing.join(', ')}"]
}
return [valid: true]
```

**7. slow_script.groovy** - For timeout testing:

```groovy
// Sleep for a long time
Thread.sleep(10000)  // 10 seconds
return [status: 'completed']
```

**8. use_env.groovy** - Environment variable access:

```groovy
// Access environment variables
return [envVar: env.TEST_VAR, home: env.HOME ?: 'unknown']
```

**9. use_variables.groovy** - Pipeline variables access:

```groovy
// Access pipeline variables
return [
    bookName : variables.book_name,
    version  : variables.version,
    customVar: customVariable ?: 'not set'
]
```

### Test Class Structure

```java
package machinum.tool;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import machinum.expression.ExpressionContext;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ExecutionContext;
import machinum.manifest.ToolManifest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GroovyScriptToolTest {

  @TempDir
  Path tempDir;

  private Path scriptDir;

  @BeforeEach
  void setUp() throws Exception {
    scriptDir = Paths.get("core/src/test/resources/scripts");
  }

  @Test
  void testConditionScriptWithTrueResult() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("is_valid.groovy", "Boolean");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("conditions/is_valid.groovy"))
        .workDir(tempDir)
        .returnType(Boolean.class)
        .sandboxed(true)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("text", "Valid content")
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertTrue((Boolean) result.outputs().get("result"));
  }

  @Test
  void testConditionScriptWithFalseResult() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("is_valid.groovy", "Boolean");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("conditions/is_valid.groovy"))
        .workDir(tempDir)
        .returnType(Boolean.class)
        .sandboxed(true)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("text", "")  // Empty text
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertFalse((Boolean) result.outputs().get("result"));
  }

  @Test
  void testTransformerScript() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("uppercase.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("transformers/uppercase.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("text", "hello world")
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("HELLO WORLD", result.outputs().get("result"));
  }

  @Test
  void testValidatorScriptWithMapReturn() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("json_structure.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("validators/json_structure.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    Map<String, Object> item = new HashMap<>();
    item.put("id", "test-123");
    item.put("type", "chapter");

    ExecutionContext context = ExecutionContext.builder()
        .put("item", item)
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertTrue((Boolean) result.outputs().get("valid"));
  }

  @Test
  void testScriptWithEnvironmentVariables() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("use_env.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("use_env.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("env", Map.of("TEST_VAR", "test-value", "HOME", "/home/test"))
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("test-value", result.outputs().get("envVar"));
  }

  @Test
  void testScriptWithPipelineVariables() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("use_variables.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("use_variables.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("variables", Map.of("book_name", "Test Book", "version", 2))
        .put("customVariable", "custom value")
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("Test Book", result.outputs().get("bookName"));
    assertEquals(2, result.outputs().get("version"));
  }

  @Test
  void testScriptCaching() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("uppercase.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("transformers/uppercase.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("text", "test")
        .build();

    // Act - Execute twice
    Tool.ToolResult result1 = tool.execute(context);
    Tool.ToolResult result2 = tool.execute(context);

    // Assert - Both should succeed and return same result (cached script)
    assertTrue(result1.success());
    assertTrue(result2.success());
    assertEquals(result1.outputs().get("result"), result2.outputs().get("result"));
  }

  @Test
  void testScriptWithTimeout() throws Exception {
    // Arrange
    ToolDefinition def = createToolDefinition("slow_script.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("slow_script.groovy"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(1))  // 1 second timeout
        .build();

    ExecutionContext context = ExecutionContext.builder().build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("timeout"));
  }

  @Test
  void testScriptWithInvalidSyntax() throws Exception {
    // Arrange - Create a temporary script with invalid syntax
    Path invalidScript = tempDir.resolve("invalid.groovy");
    Files.writeString(invalidScript, "return invalid syntax here !!!");

    ToolDefinition def = createToolDefinition("invalid.groovy");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(invalidScript)
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder().build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("compilation") ||
               result.errorMessage().contains("syntax"));
  }

  @Test
  void testScriptWithReturnTypeValidation() throws Exception {
    // Arrange - Script returns String but expects Boolean
    ToolDefinition def = createToolDefinition("uppercase.groovy", "Boolean");
    GroovyScriptTool tool = GroovyScriptTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("transformers/uppercase.groovy"))
        .workDir(tempDir)
        .returnType(Boolean.class)  // Expect Boolean
        .timeout(Duration.ofSeconds(5))
        .build();

    ExecutionContext context = ExecutionContext.builder()
        .put("text", "hello")
        .build();

    // Act
    Tool.ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("returned") &&
               result.errorMessage().contains("expected"));
  }
}
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` section 5.1 - External Tools
- **GroovyScriptTool Implementation**: `tools/external/src/main/java/machinum/tool/GroovyScriptTool.java`
- **ExternalTool Base**: `tools/common/src/main/java/machinum/tool/ExternalTool.java`

**Files to Create**:

- `core/src/test/java/machinum/tool/GroovyScriptToolTest.java`
- `core/src/test/resources/scripts/conditions/is_valid.groovy`
- `core/src/test/resources/scripts/conditions/type_check.groovy`
- `core/src/test/resources/scripts/transformers/uppercase.groovy`
- `core/src/test/resources/scripts/transformers/extract_metadata.groovy`
- `core/src/test/resources/scripts/validators/has_content.groovy`
- `core/src/test/resources/scripts/validators/json_structure.groovy`
- `core/src/test/resources/scripts/slow_script.groovy`
- `core/src/test/resources/scripts/use_env.groovy`
- `core/src/test/resources/scripts/use_variables.groovy`

**Files to Read**:

- `tools/external/src/main/java/machinum/tool/GroovyScriptTool.java` (lines 1-268)
- `core/src/test/java/machinum/expression/DefaultExpressionResolverTest.java` - Test style reference

---

## Spec

### Contracts

**GroovyScriptTool Builder**:

```java
GroovyScriptTool.builder()
    .

definition(ToolDefinition)
    .

scriptPath(Path)
    .

workDir(Path)
    .

timeout(Duration)
    .

returnType(Class<?>)  // Optional
    .

sandboxed(boolean)   // Default: true
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

- Valid Groovy syntax
- Access to binding variables: `item`, `text`, `index`, `env`, `variables`, etc.
- Return appropriate type for script purpose

**Binding Variables Available**:

- `item`: Current item (Map)
- `text`: Current text (String)
- `index`: Element index (int)
- `textLength`, `textWords`, `textTokens`: Text metrics
- `runId`: Run identifier
- `state`, `tool`: Current state/tool definitions
- `retryAttempt`: Retry count
- `env`: Environment variables map
- `variables`: Pipeline variables map

### Checklists

**Verification Commands**:

```bash
# Run GroovyScriptTool integration tests
./gradlew :core:test --tests "*GroovyScriptToolTest*"

# Run with verbose output
./gradlew :core:test --tests "*GroovyScriptToolTest*" --info

# Verify test scripts exist
find core/src/test/resources/scripts -name "*.groovy" -type f
```

### Plan

1. **Create test scripts** in subdirectories (conditions/, transformers/, validators/)
2. **Create test class** `GroovyScriptToolTest.java`
3. **Implement condition script tests** (true/false results)
4. **Implement transformer script tests** (text transformation)
5. **Implement validator script tests** (validation with Map return)
6. **Implement environment variable test**
7. **Implement pipeline variable test**
8. **Implement script caching test**
9. **Implement timeout test**
10. **Implement error handling tests** (invalid syntax, wrong return type)
11. **Run all tests** and fix any issues

### Quickstart

- `tools/external/src/main/java/machinum/tool/GroovyScriptTool.java` - Tool implementation
- `core/src/test/resources/scripts/` - Directory for test scripts
- `examples/scripts/` - Example scripts for reference

---

## TDD Approach

### 1. Create Test Scripts First

Create minimal Groovy scripts for each use case:

- Conditions (Boolean return)
- Transformers (Map return)
- Validators (Map with validation result)

### 2. Write Failing Tests

Write tests that exercise different scenarios

### 3. Make Tests Pass

Ensure GroovyScriptTool correctly executes scripts with proper binding

### 4. Refine and Extend

- Add edge case tests (null values, empty strings, large data)
- Add security tests (sandbox restrictions)
- Add performance tests (script caching effectiveness)

---

## Result

Link to: `docs/results/5.2-groovyscripttool-integration-test.result.md`
