# Implementation Tasks: External Tools & Workspace Management

**Feature**: `002-external-tools-support`
**Date**: 2026-03-25

## Task Organization

Tasks are organized by implementation phase and dependency order. Each task is independently testable and builds on
previous tasks.

---

## Phase 0: Foundation & Setup

### Task 0.1: Add Groovy Dependency

**Priority**: P0 | **Estimated**: 0.5h | **Type**: Build Configuration

**Description**: Add Groovy 4.0+ dependency to Gradle build for expression resolution and script execution.

**Acceptance Criteria**:

- [x] Groovy 4.0+ added to `core/build.gradle` or root `build.gradle`
- [x] Dependency version aligned with TDD (Groovy 4.0+)
- [x] Build compiles successfully with new dependency
- [x] Groovy classes can be imported in Java code

**Implementation Notes**:

```groovy
dependencies {
  implementation 'org.apache.groovy:groovy:4.0.29'
  implementation 'org.apache.groovy:groovy-jsr223:4.0.29' // Optional for scripting
}
```

**Dependencies**: None

---

### Task 0.2: Create ExpressionResolver Interface

**Priority**: P0 | **Estimated**: 1h | **Type**: Core Interface

**Description**: Define the `ExpressionResolver` interface to replace Phase 1 temporary implementation.

**Acceptance Criteria**:

- [x] Interface `ExpressionResolver` created in `core/src/main/java/machinum/expression/`
- [x] Method `resolveTemplate(String template, ExpressionContext ctx): Object` defined
- [x] Method `supportsInlineExpression(String value): boolean` defined
- [x] Interface aligned with TDD section 5.2

**Implementation Notes**:

```java
package machinum.expression;

public interface ExpressionResolver {

  Object resolveTemplate(String template, ExpressionContext ctx);

  boolean supportsInlineExpression(String value);
}
```

**Dependencies**: Task 0.1

---

### Task 0.3: Create ExpressionContext Class

**Priority**: P0 | **Estimated**: 1.5h | **Type**: Core Model

**Description**: Implement `ExpressionContext` to hold all predefined variables for expression resolution.

**Acceptance Criteria**:

- [x] Class `ExpressionContext` created with all predefined variables from TDD section 4.4
- [x] Builder pattern or constructor for easy creation
- [x] Getter methods for all variables
- [x] Environment variable map included
- [x] Pipeline variables map included

**Implementation Notes**:
Include fields: `item`, `text`, `index`, `textLength`, `textWords`, `textTokens`, `aggregationIndex`, `aggregationText`,
`runId`, `state`, `tool`, `retryAttempt`, `env`, `variables`

**Dependencies**: Task 0.2

---

## Phase 1: External Tool Implementation

### Task 1.1: Create ExternalTool Base Class

**Priority**: P0 | **Estimated**: 2h | **Type**: Core Implementation

**Description**: Implement abstract base class for all external tools with common functionality.

**Acceptance Criteria**:

- [x] Abstract class `ExternalTool` extends `Tool` interface
- [x] Common fields: `runtime`, `workDir`, `timeout`, `retryPolicy`, `executionTarget`
- [x] Constructor to initialize common fields from config
- [x] Abstract method `execute(JsonNode input, ToolContext context): JsonNode`
- [x] Helper method for timeout enforcement

**Implementation Notes**:

```java
public abstract class ExternalTool implements Tool {

  protected final String runtime;
  protected final Path workDir;
  protected final Duration timeout;
  protected final RetryPolicy retryPolicy;
  protected final ExecutionTarget target;

  // Constructor and getters
}
```

**Dependencies**: Task 0.1

---

### Task 1.2: Implement ShellTool

**Priority**: P0 | **Estimated**: 3h | **Type**: Core Implementation

**Description**: Implement shell script execution tool using ProcessBuilder.

**Acceptance Criteria**:

- [x] Class `ShellTool` extends `ExternalTool`
- [x] Fields: `scriptPath`, `args`, `environment`, `interpreter`
- [x] `execute()` method runs script via ProcessBuilder
- [x] Timeout enforced via `Process.waitFor(timeout, TimeUnit)`
- [x] Exit code validated (0 = success)
- [x] Stdout captured and parsed as JSON
- [x] Stderr logged for debugging
- [x] Environment variables injected from config

**Implementation Notes**:

```java
ProcessBuilder pb = new ProcessBuilder(interpreter, scriptPath.toString());
pb.

arguments().

addAll(args);
pb.

directory(workDir.toFile());
    pb.

environment().

putAll(environment);
pb.

redirectErrorStream(true);

Process process = pb.start();
boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
```

**Dependencies**: Task 1.1

---

### Task 1.3: Implement GroovyScriptTool

**Priority**: P0 | **Estimated**: 3h | **Type**: Core Implementation

**Description**: Implement Groovy script execution tool with secure sandboxing.

**Acceptance Criteria**:

- [x] Class `GroovyScriptTool` extends `ExternalTool`
- [x] Fields: `scriptPath`, `binding`, `groovyShell`, `returnType`, `sandboxed`
- [x] `execute()` method evaluates script with GroovyShell
- [x] Binding populated with context variables
- [x] Security sandbox enabled by default
- [x] Return type validated (Boolean for conditions)
- [x] Script compilation cached for performance

**Implementation Notes**:

```java
Binding binding = new Binding();
binding.

setVariable("item",currentItem);
binding.

setVariable("text",currentText);

GroovyShell shell = new GroovyShell(binding);
Object result = shell.evaluate(scriptFile);
```

**Dependencies**: Task 1.1, Task 0.3

---

### Task 1.4: Add Script Path Validation

**Priority**: P1 | **Estimated**: 1.5h | **Type**: Validation

**Description**: Validate script paths at pipeline load time to fail fast on missing scripts.

**Acceptance Criteria**:

- [x] Pipeline loader validates all script paths exist
- [x] Clear error message includes missing script path and tool name
- [x] Validation occurs before execution starts
- [x] Shell scripts checked for executable permission

**Dependencies**: Task 1.2, Task 1.3

---

## Phase 2: Expression Resolution

### Task 2.1: Implement GroovyExpressionResolver

**Priority**: P0 | **Estimated**: 4h | **Type**: Core Implementation

**Description**: Replace temporary expression resolver with Groovy-based implementation.

**Acceptance Criteria**:

- [x] Class `GroovyExpressionResolver` implements `ExpressionResolver`
- [x] `resolveTemplate()` extracts `{{...}}` and evaluates with GroovyShell
- [x] All predefined variables available in binding
- [x] Environment variables accessible via `env.VARIABLE_NAME`
- [x] Timeout enforced (default: 5s)
- [x] Compiled scripts cached for repeated evaluations
- [x] Null safety: undefined variables resolve to null
- [x] Descriptive errors for failed resolutions

**Implementation Notes**:

```java
String expression = template.substring(2, template.length() - 2); // Remove {{ }}
CompiledScript compiled = cache.computeIfAbsent(expression, this::compile);
Binding binding = createBinding(context);
return compiled.

invoke(binding);
```

**Dependencies**: Task 0.2, Task 0.3, Task 1.3

---

### Task 2.2: Support Script-Based Expressions

**Priority**: P1 | **Estimated**: 2h | **Type**: Core Enhancement

**Description**: Enable expressions like `{{scripts.conditions.should_clean(item)}}` to load and execute scripts
dynamically.

**Acceptance Criteria**:

- [x] `ScriptRegistry` class created to locate scripts by type/name
- [x] Expression resolver recognizes `scripts.` prefix
- [x] Script loaded from `.mt/scripts/{type}/{name}.groovy`
- [x] Script executed with provided arguments
- [x] Return value used in expression result

**Implementation Notes**:

```java
if(expression.startsWith("scripts.")){
Path scriptPath = scriptRegistry.getScript(expression);
    return

evaluateScript(scriptPath, context);
}
```

**Dependencies**: Task 2.1, Task 1.3

---

### Task 2.3: Integrate ExpressionResolver into Pipeline

**Priority**: P0 | **Estimated**: 2h | **Type**: Integration

**Description**: Wire up Groovy expression resolver in pipeline execution context.

**Acceptance Criteria**:

- [x] `PipelineStateMachine` receives `ExpressionResolver` dependency
- [x] Tool configs resolved via expression resolver before execution
- [x] State conditions evaluated via expression resolver
- [x] All predefined variables populated in context

**Dependencies**: Task 2.1

---

## Phase 3: Workspace Initialization

### Task 3.1: Create WorkspaceLayout Class

**Priority**: P0 | **Estimated**: 1.5h | **Type**: Core Model

**Description**: Define workspace directory structure and validation logic.

**Acceptance Criteria**:

- [x] Constants for all directory paths (`.mt/`, `src/main/`, etc.)
- [x] Method `validate(Path workspaceRoot): ValidationResult`
- [x] Method `createDirectories(Path workspaceRoot): void`
- [x] Method `getScriptPath(ScriptType type, String name): Path`
- [x] `.gitkeep` files created in empty directories

**Dependencies**: None

---

### Task 3.2: Create WorkspaceInitializerTool Class

**Priority**: P0 | **Estimated**: 3h | **Type**: Core Implementation

**Description**: Implement workspace initialization with download/bootstrap phases.

**Acceptance Criteria**:

- [x] Method `install()` runs download → bootstrap
- [x] Method `download()` fetches tool sources without workspace mutation
- [x] Method `bootstrap()` creates directory structure
- [x] Template files copied for `seed.yaml` and `.mt/tools.yaml`
- [x] Idempotent: skips existing files without `--force` flag
- [x] Clear logging of created files/directories

**Dependencies**: Task 3.1

---

### Task 3.3: Implement Package.json Generation

**Priority**: P1 | **Estimated**: 2h | **Type**: Core Enhancement

**Description**: Generate `package.json` when node tools are declared in `tools.yaml`.

**Acceptance Criteria**:

- [x] Detect node tools in `install.tools` section
- [x] Generate minimal `package.json` with required dependencies
- [x] Only generated if node tools present
- [x] Skipped if `package.json` already exists (without `--force`)

**Implementation Notes**:

```json
{
  "name": "machinum-workspace",
  "version": "1.0.0",
  "dependencies": {
    // From node tool declarations
  }
}
```

**Dependencies**: Task 3.2

---

### Task 3.4: Create InstallCommand CLI

**Priority**: P0 | **Estimated**: 2h | **Type**: CLI

**Description**: Implement Picocli command for `machinum install`.

**Acceptance Criteria**:

- [x] `InstallCommand` class with Picocli annotations
- [x] Subcommands: `download`, `bootstrap`, (default: both)
- [x] `--force` flag to overwrite existing files
- [x] `--workspace` option to specify root directory
- [x] Structured logging of progress
- [x] Exit code 0 on success, non-zero on failure

**Implementation Notes**:

```java

@Command(name = "install", subcommands = {DownloadCommand.class, BootstrapCommand.class})
class InstallCommand implements Runnable { ...
}
```

**Dependencies**: Task 3.2, Task 3.3

---

### Task 3.5: Create Template Files

**Priority**: P1 | **Estimated**: 1.5h | **Type**: Configuration

**Description**: Create template files for workspace initialization.

**Acceptance Criteria**:

- [x] `conf/templates/seed.yaml.template` with sensible defaults
- [x] `conf/templates/tools.yaml.template` with example tools
- [x] Templates are valid YAML
- [x] Templates include comments explaining each section

**Dependencies**: Task 3.2

---

## Phase 4: Cleanup Command

### Task 4.1: Create CleanupPolicy Class

**Priority**: P1 | **Estimated**: 2h | **Type**: Core Model

**Description**: Parse and apply cleanup retention policies from root config.

**Acceptance Criteria**:

- [x] Fields: `successRetention`, `failedRetention`, `maxSuccessfulRuns`, `maxFailedRuns`
- [x] Parse duration strings (e.g., "5d", "24h", "1w")
- [x] Method `shouldKeep(RunMetadata run, List<RunMetadata> allRuns): boolean`
- [x] Method `getAge(Path runDir): Duration`
- [x] Default values from TDD section 7.2

**Dependencies**: None

---

### Task 4.2: Create RunScanner Utility

**Priority**: P1 | **Estimated**: 1.5h | **Type**: Utility

**Description**: Scan and enumerate runs by age/status for cleanup.

**Acceptance Criteria**:

- [x] Method `getAllRuns(Path stateDir): List<RunMetadata>`
- [x] Method `getRunsOlderThan(Duration age): List<RunMetadata>`
- [x] Method `getRunsByStatus(RunStatus status): List<RunMetadata>`
- [x] Parse checkpoint.json for run metadata

**Dependencies**: Task 4.1

---

### Task 4.3: Implement Cleanup Logic

**Priority**: P1 | **Estimated**: 2h | **Type**: Core Implementation

**Description**: Apply cleanup policies to remove old runs.

**Acceptance Criteria**:

- [x] Age-based cleanup applied first
- [x] Count-based cleanup applied second
- [x] Active runs protected from deletion
- [x] Deletion logged with run-id and reason
- [x] Partial failures don't stop entire cleanup

**Dependencies**: Task 4.1, Task 4.2

---

### Task 4.4: Create CleanupCommand CLI

**Priority**: P1 | **Estimated**: 2h | **Type**: CLI

**Description**: Implement Picocli command for `machinum cleanup`.

**Acceptance Criteria**:

- [x] `CleanupCommand` class with Picocli annotations
- [x] `--run-id <id>` option for specific run cleanup
- [x] `--older-than <duration>` option for age-based cleanup
- [x] `--force` flag to clean active runs
- [x] `--dry-run` option to preview without deleting
- [x] Summary output: X runs cleaned, Y retained

**Dependencies**: Task 4.3

---

## Phase 5: Integration & Testing

### Task 5.1: Write ShellTool Integration Test

**Priority**: P0 | **Estimated**: 2h | **Type**: Test

**Description**: Create integration test for shell tool execution.

**Acceptance Criteria**:

- [x] Test script created in `core/src/test/resources/scripts/`
- [x] Test verifies script executes with correct input
- [x] Test verifies timeout enforcement
- [x] Test verifies exit code handling
- [x] Test verifies environment variable injection

**Dependencies**: Task 1.2

---

### Task 5.2: Write GroovyScriptTool Integration Test

**Priority**: P0 | **Estimated**: 2h | **Type**: Test

**Description**: Create integration test for Groovy script execution.

**Acceptance Criteria**:

- [x] Test scripts for conditions, transformers, validators
- [x] Test verifies binding populated correctly
- [x] Test verifies return type validation
- [x] Test verifies security sandbox (if enabled)
- [x] Test verifies script caching

**Dependencies**: Task 1.3

---

### Task 5.3: Write ExpressionResolver Tests

**Priority**: P0 | **Estimated**: 3h | **Type**: Test

**Description**: Comprehensive tests for Groovy expression resolution.

**Acceptance Criteria**:

- [x] Test all predefined variables resolve correctly
- [x] Test environment variable resolution
- [x] Test script-based expressions
- [x] Test timeout enforcement
- [x] Test null safety
- [x] Test error messages for invalid expressions

**Dependencies**: Task 2.1, Task 2.2

---

### Task 5.4: Write Workspace Init Integration Test

**Priority**: P1 | **Estimated**: 2h | **Type**: Test

**Description**: Test full workspace initialization flow.

**Acceptance Criteria**:

- [x] Test in temporary directory
- [x] Verify all directories created
- [x] Verify template files generated
- [x] Verify idempotency (second run skips existing)
- [x] Verify `--force` overwrites
- [x] Verify package.json generation when node tools present

**Dependencies**: Task 3.4, Task 3.3

---

### Task 5.5: Write Cleanup Integration Test

**Priority**: P1 | **Estimated**: 2h | **Type**: Test

**Description**: Test cleanup command with various retention policies.

**Acceptance Criteria**:

- [x] Create mock runs with different ages/statuses
- [x] Test `--older-than` removes correct runs
- [x] Test `--run-id` removes specific run
- [x] Test policy-based retention
- [x] Test active run protection
- [x] Test `--dry-run` preview mode

**Dependencies**: Task 4.4

---

### Task 5.6: Write End-to-End Pipeline Test

**Priority**: P0 | **Estimated**: 3h | **Type**: Test

**Description**: Full pipeline with external tools, expressions, and workspace init.

**Acceptance Criteria**:

- [x] Initialize workspace via `machinum install`
- [x] Create pipeline with shell and Groovy tools
- [x] Execute pipeline end-to-end
- [x] Verify checkpoint created
- [x] Verify structured logs with correlation IDs
- [x] Verify all user stories from spec.md

**Dependencies**: All previous tasks

---

## Phase 6: Documentation & Polish

### Task 6.1: Update Quickstart Guide

**Priority**: P1 | **Estimated**: 1.5h | **Type**: Documentation

**Description**: Add external tools and workspace init examples to quickstart.

**Acceptance Criteria**:

- [x] Example: `machinum install` usage
- [x] Example: Shell tool in pipeline
- [x] Example: Groovy condition script
- [x] Example: `machinum cleanup` usage
- [x] Example: Expression resolution

**Dependencies**: All implementation tasks complete

---

### Task 6.2: Create Example Scripts

**Priority**: P1 | **Estimated**: 2h | **Type**: Examples

**Description**: Provide example scripts for common use cases.

**Acceptance Criteria**:

- [x] Example condition script: `should_clean.groovy`
- [x] Example transformer script: `normalize_text.groovy`
- [x] Example validator script: `validate_json.groovy`
- [x] Example shell script: `format_markdown.sh`
- [x] Scripts documented with comments
- [x] Scripts tested and working

**Dependencies**: Task 1.2, Task 1.3

---

### Task 6.3: Update TDD if Needed

**Priority**: P2 | **Estimated**: 1h | **Type**: Documentation

**Description**: Update `docs/tdd.md` if any architectural decisions changed during implementation.

**Acceptance Criteria**:

- [x] Review implementation against TDD
- [x] Update TDD if gaps found
- [x] Document any deviations from original plan
- [x] Update constitution if needed

**Dependencies**: Implementation complete

---

## Task Summary

| Phase                    | Tasks  | Estimated Hours |
|--------------------------|--------|-----------------|
| 0: Foundation            | 3      | 3h              |
| 1: External Tools        | 4      | 9.5h            |
| 2: Expression Resolution | 3      | 8h              |
| 3: Workspace Init        | 5      | 10h             |
| 4: Cleanup               | 4      | 7.5h            |
| 5: Testing               | 6      | 14h             |
| 6: Documentation         | 3      | 4.5h            |
| **Total**                | **28** | **56.5h**       |

---

## Critical Path

**Phase 0 → Phase 1 → Phase 2 → Phase 5** (External tools and expression resolution are blocking for MVP)

**Phase 3 → Phase 4 → Phase 5** (Workspace init and cleanup can be parallel with Phase 1-2)

---

## Implementation Order Recommendation

1. **Week 1**: Phase 0 (Foundation) + Phase 1 (External Tools) + Task 5.1, 5.2
2. **Week 2**: Phase 2 (Expression Resolution) + Task 5.3
3. **Week 3**: Phase 3 (Workspace Init) + Phase 4 (Cleanup)
4. **Week 4**: Phase 5 (E2E Testing) + Phase 6 (Documentation)
