# Implementation Tasks: External Tools & Workspace Management

**Feature**: `002-external-tools-support`
**Date**: 2026-03-25
**Branch**: `002-external-tools-support`
**Input**: `specs/002-external-tools-support/spec.md`, `specs/002-external-tools-support/plan.md`, `specs/002-external-tools-support/data-model.md`

## Task Organization

Tasks are organized by implementation phase and dependency order. Each task is independently testable and builds on previous tasks.

---

## Phase 0: Foundation & Setup

### Task 0.1: Add Groovy Dependency
**Priority**: P0 | **Estimated**: 0.5h | **Type**: Build Configuration

**Description**: Add Groovy 4.0+ dependency to Gradle build for expression resolution and script execution.

**Acceptance Criteria**:
- [ ] Groovy 4.0+ added to `core/build.gradle` or root `build.gradle`
- [ ] Dependency version aligned with TDD (Groovy 4.0+)
- [ ] Build compiles successfully with new dependency
- [ ] Groovy classes can be imported in Java code

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
- [ ] Interface `ExpressionResolver` created in `core/src/main/java/machinum/expression/`
- [ ] Method `resolveTemplate(String template, ExpressionContext ctx): Object` defined
- [ ] Method `supportsInlineExpression(String value): boolean` defined
- [ ] Interface aligned with TDD section 5.2

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
- [ ] Class `ExpressionContext` created with all predefined variables from TDD section 4.4
- [ ] Builder pattern or constructor for easy creation
- [ ] Getter methods for all variables
- [ ] Environment variable map included
- [ ] Pipeline variables map included

**Implementation Notes**:
Include fields: `item`, `text`, `index`, `textLength`, `textWords`, `textTokens`, `aggregationIndex`, `aggregationText`, `runId`, `state`, `tool`, `retryAttempt`, `env`, `variables`

**Dependencies**: Task 0.2

---

## Phase 1: External Tool Implementation

### Task 1.1: Create ExternalTool Base Class
**Priority**: P0 | **Estimated**: 2h | **Type**: Core Implementation

**Description**: Implement abstract base class for all external tools with common functionality.

**Acceptance Criteria**:
- [ ] Abstract class `ExternalTool` extends `Tool` interface
- [ ] Common fields: `runtime`, `workDir`, `timeout`, `retryPolicy`, `executionTarget`
- [ ] Constructor to initialize common fields from config
- [ ] Abstract method `execute(JsonNode input, ToolContext context): JsonNode`
- [ ] Helper method for timeout enforcement

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
- [ ] Class `ShellTool` extends `ExternalTool`
- [ ] Fields: `scriptPath`, `args`, `environment`, `interpreter`
- [ ] `execute()` method runs script via ProcessBuilder
- [ ] Timeout enforced via `Process.waitFor(timeout, TimeUnit)`
- [ ] Exit code validated (0 = success)
- [ ] Stdout captured and parsed as JSON
- [ ] Stderr logged for debugging
- [ ] Environment variables injected from config

**Implementation Notes**:
```java
ProcessBuilder pb = new ProcessBuilder(interpreter, scriptPath.toString());
pb.arguments().addAll(args);
pb.directory(workDir.toFile());
pb.environment().putAll(environment);
pb.redirectErrorStream(true);
Process process = pb.start();
boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
```

**Dependencies**: Task 1.1

---

### Task 1.3: Implement GroovyScriptTool
**Priority**: P0 | **Estimated**: 3h | **Type**: Core Implementation

**Description**: Implement Groovy script execution tool with secure sandboxing.

**Acceptance Criteria**:
- [ ] Class `GroovyScriptTool` extends `ExternalTool`
- [ ] Fields: `scriptPath`, `binding`, `groovyShell`, `returnType`, `sandboxed`
- [ ] `execute()` method evaluates script with GroovyShell
- [ ] Binding populated with context variables
- [ ] Security sandbox enabled by default
- [ ] Return type validated (Boolean for conditions)
- [ ] Script compilation cached for performance

**Implementation Notes**:
```java
Binding binding = new Binding();
binding.setVariable("item", currentItem);
binding.setVariable("text", currentText);
GroovyShell shell = new GroovyShell(binding);
Object result = shell.evaluate(scriptFile);
```

**Dependencies**: Task 1.1, Task 0.3

---

### Task 1.4: Add Script Path Validation
**Priority**: P1 | **Estimated**: 1.5h | **Type**: Validation

**Description**: Validate script paths at pipeline load time to fail fast on missing scripts.

**Acceptance Criteria**:
- [ ] Pipeline loader validates all script paths exist
- [ ] Clear error message includes missing script path and tool name
- [ ] Validation occurs before execution starts
- [ ] Shell scripts checked for executable permission

**Dependencies**: Task 1.2, Task 1.3

---

## Phase 2: Expression Resolution

### Task 2.1: Implement GroovyExpressionResolver
**Priority**: P0 | **Estimated**: 4h | **Type**: Core Implementation

**Description**: Replace temporary expression resolver with Groovy-based implementation.

**Acceptance Criteria**:
- [ ] Class `GroovyExpressionResolver` implements `ExpressionResolver`
- [ ] `resolveTemplate()` extracts `{{...}}` and evaluates with GroovyShell
- [ ] All predefined variables available in binding
- [ ] Environment variables accessible via `env.VARIABLE_NAME`
- [ ] Timeout enforced (default: 5s)
- [ ] Compiled scripts cached for repeated evaluations
- [ ] Null safety: undefined variables resolve to null
- [ ] Descriptive errors for failed resolutions

**Implementation Notes**:
```java
String expression = template.substring(2, template.length() - 2); // Remove {{ }}
CompiledScript compiled = cache.computeIfAbsent(expression, this::compile);
Binding binding = createBinding(context);
return compiled.invoke(binding);
```

**Dependencies**: Task 0.2, Task 0.3, Task 1.3

---

### Task 2.2: Support Script-Based Expressions
**Priority**: P1 | **Estimated**: 2h | **Type**: Core Enhancement

**Description**: Enable expressions like `{{scripts.conditions.should_clean(item)}}` to load and execute scripts dynamically.

**Acceptance Criteria**:
- [ ] `ScriptRegistry` class created to locate scripts by type/name
- [ ] Expression resolver recognizes `scripts.` prefix
- [ ] Script loaded from `.mt/scripts/{type}/{name}.groovy`
- [ ] Script executed with provided arguments
- [ ] Return value used in expression result

**Implementation Notes**:
```java
if (expression.startsWith("scripts.")) {
    Path scriptPath = scriptRegistry.getScript(expression);
    return evaluateScript(scriptPath, context);
}
```

**Dependencies**: Task 2.1, Task 1.3

---

### Task 2.3: Integrate ExpressionResolver into Pipeline
**Priority**: P0 | **Estimated**: 2h | **Type**: Integration

**Description**: Wire up Groovy expression resolver in pipeline execution context.

**Acceptance Criteria**:
- [ ] `PipelineStateMachine` receives `ExpressionResolver` dependency
- [ ] Tool configs resolved via expression resolver before execution
- [ ] State conditions evaluated via expression resolver
- [ ] All predefined variables populated in context

**Dependencies**: Task 2.1

---

## Phase 3: Workspace Initialization

### Task 3.1: Create WorkspaceLayout Class
**Priority**: P0 | **Estimated**: 1.5h | **Type**: Core Model

**Description**: Define workspace directory structure and validation logic.

**Acceptance Criteria**:
- [ ] Constants for all directory paths (`.mt/`, `src/main/`, etc.)
- [ ] Method `validate(Path workspaceRoot): ValidationResult`
- [ ] Method `createDirectories(Path workspaceRoot): void`
- [ ] Method `getScriptPath(ScriptType type, String name): Path`
- [ ] `.gitkeep` files created in empty directories

**Dependencies**: None

---

### Task 3.2: Create WorkspaceInitializerTool Class
**Priority**: P0 | **Estimated**: 3h | **Type**: Core Implementation

**Description**: Implement workspace initialization with download/bootstrap phases.

**Acceptance Criteria**:
- [ ] Method `install()` runs download → bootstrap
- [ ] Method `download()` fetches tool sources without workspace mutation
- [ ] Method `bootstrap()` creates directory structure
- [ ] Template files copied for `seed.yaml` and `.mt/tools.yaml`
- [ ] Idempotent: skips existing files without `--force` flag
- [ ] Clear logging of created files/directories

**Dependencies**: Task 3.1

---

### Task 3.3: Implement Package.json Generation
**Priority**: P1 | **Estimated**: 2h | **Type**: Core Enhancement

**Description**: Generate `package.json` when node tools are declared in `tools.yaml`.

**Acceptance Criteria**:
- [ ] Detect node tools in `install.tools` section
- [ ] Generate minimal `package.json` with required dependencies
- [ ] Only generated if node tools present
- [ ] Skipped if `package.json` already exists (without `--force`)

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
- [ ] `InstallCommand` class with Picocli annotations
- [ ] Subcommands: `download`, `bootstrap`, (default: both)
- [ ] `--force` flag to overwrite existing files
- [ ] `--workspace` option to specify root directory
- [ ] Structured logging of progress
- [ ] Exit code 0 on success, non-zero on failure

**Implementation Notes**:
```java
@Command(name = "install", subcommands = {DownloadCommand.class, BootstrapCommand.class})
class InstallCommand implements Runnable { ... }
```

**Dependencies**: Task 3.2, Task 3.3

---

### Task 3.5: Create Template Files
**Priority**: P1 | **Estimated**: 1.5h | **Type**: Configuration

**Description**: Create template files for workspace initialization.

**Acceptance Criteria**:
- [ ] `conf/templates/seed.yaml.template` with sensible defaults
- [ ] `conf/templates/tools.yaml.template` with example tools
- [ ] Templates are valid YAML
- [ ] Templates include comments explaining each section

**Dependencies**: Task 3.2

---

## Phase 4: Cleanup Command

### Task 4.1: Create CleanupPolicy Class
**Priority**: P1 | **Estimated**: 2h | **Type**: Core Model

**Description**: Parse and apply cleanup retention policies from root config.

**Acceptance Criteria**:
- [ ] Fields: `successRetention`, `failedRetention`, `maxSuccessfulRuns`, `maxFailedRuns`
- [ ] Parse duration strings (e.g., "5d", "24h", "1w")
- [ ] Method `shouldKeep(RunMetadata run, List<RunMetadata> allRuns): boolean`
- [ ] Method `getAge(Path runDir): Duration`
- [ ] Default values from TDD section 7.2

**Dependencies**: None

---

### Task 4.2: Create RunScanner Utility
**Priority**: P1 | **Estimated**: 1.5h | **Type**: Utility

**Description**: Scan and enumerate runs by age/status for cleanup.

**Acceptance Criteria**:
- [ ] Method `getAllRuns(Path stateDir): List<RunMetadata>`
- [ ] Method `getRunsOlderThan(Duration age): List<RunMetadata>`
- [ ] Method `getRunsByStatus(RunStatus status): List<RunMetadata>`
- [ ] Parse checkpoint.json for run metadata

**Dependencies**: Task 4.1

---

### Task 4.3: Implement Cleanup Logic
**Priority**: P1 | **Estimated**: 2h | **Type**: Core Implementation

**Description**: Apply cleanup policies to remove old runs.

**Acceptance Criteria**:
- [ ] Age-based cleanup applied first
- [ ] Count-based cleanup applied second
- [ ] Active runs protected from deletion
- [ ] Deletion logged with run-id and reason
- [ ] Partial failures don't stop entire cleanup

**Dependencies**: Task 4.1, Task 4.2

---

### Task 4.4: Create CleanupCommand CLI
**Priority**: P1 | **Estimated**: 2h | **Type**: CLI

**Description**: Implement Picocli command for `machinum cleanup`.

**Acceptance Criteria**:
- [ ] `CleanupCommand` class with Picocli annotations
- [ ] `--run-id <id>` option for specific run cleanup
- [ ] `--older-than <duration>` option for age-based cleanup
- [ ] `--force` flag to clean active runs
- [ ] `--dry-run` option to preview without deleting
- [ ] Summary output: X runs cleaned, Y retained

**Dependencies**: Task 4.3

---

## Phase 5: Integration & Testing

### Task 5.1: Write ShellTool Integration Test
**Priority**: P0 | **Estimated**: 2h | **Type**: Test

**Description**: Create integration test for shell tool execution.

**Acceptance Criteria**:
- [ ] Test script created in `core/src/test/resources/scripts/`
- [ ] Test verifies script executes with correct input
- [ ] Test verifies timeout enforcement
- [ ] Test verifies exit code handling
- [ ] Test verifies environment variable injection

**Dependencies**: Task 1.2

---

### Task 5.2: Write GroovyScriptTool Integration Test
**Priority**: P0 | **Estimated**: 2h | **Type**: Test

**Description**: Create integration test for Groovy script execution.

**Acceptance Criteria**:
- [ ] Test scripts for conditions, transformers, validators
- [ ] Test verifies binding populated correctly
- [ ] Test verifies return type validation
- [ ] Test verifies security sandbox (if enabled)
- [ ] Test verifies script caching

**Dependencies**: Task 1.3

---

### Task 5.3: Write ExpressionResolver Tests
**Priority**: P0 | **Estimated**: 3h | **Type**: Test

**Description**: Comprehensive tests for Groovy expression resolution.

**Acceptance Criteria**:
- [ ] Test all predefined variables resolve correctly
- [ ] Test environment variable resolution
- [ ] Test script-based expressions
- [ ] Test timeout enforcement
- [ ] Test null safety
- [ ] Test error messages for invalid expressions

**Dependencies**: Task 2.1, Task 2.2

---

### Task 5.4: Write Workspace Init Integration Test
**Priority**: P1 | **Estimated**: 2h | **Type**: Test

**Description**: Test full workspace initialization flow.

**Acceptance Criteria**:
- [ ] Test in temporary directory
- [ ] Verify all directories created
- [ ] Verify template files generated
- [ ] Verify idempotency (second run skips existing)
- [ ] Verify `--force` overwrites
- [ ] Verify package.json generation when node tools present

**Dependencies**: Task 3.4, Task 3.3

---

### Task 5.5: Write Cleanup Integration Test
**Priority**: P1 | **Estimated**: 2h | **Type**: Test

**Description**: Test cleanup command with various retention policies.

**Acceptance Criteria**:
- [ ] Create mock runs with different ages/statuses
- [ ] Test `--older-than` removes correct runs
- [ ] Test `--run-id` removes specific run
- [ ] Test policy-based retention
- [ ] Test active run protection
- [ ] Test `--dry-run` preview mode

**Dependencies**: Task 4.4

---

### Task 5.6: Write End-to-End Pipeline Test
**Priority**: P0 | **Estimated**: 3h | **Type**: Test

**Description**: Full pipeline with external tools, expressions, and workspace init.

**Acceptance Criteria**:
- [ ] Initialize workspace via `machinum install`
- [ ] Create pipeline with shell and Groovy tools
- [ ] Execute pipeline end-to-end
- [ ] Verify checkpoint created
- [ ] Verify structured logs with correlation IDs
- [ ] Verify all user stories from spec.md

**Dependencies**: All previous tasks

---

## Phase 6: Documentation & Polish

### Task 6.1: Update Quickstart Guide
**Priority**: P1 | **Estimated**: 1.5h | **Type**: Documentation

**Description**: Add external tools and workspace init examples to quickstart.

**Acceptance Criteria**:
- [ ] `specs/002-external-tools-support/quickstart.md` created
- [ ] Example: `machinum install` usage
- [ ] Example: Shell tool in pipeline
- [ ] Example: Groovy condition script
- [ ] Example: `machinum cleanup` usage
- [ ] Example: Expression resolution

**Dependencies**: All implementation tasks complete

---

### Task 6.2: Create Example Scripts
**Priority**: P1 | **Estimated**: 2h | **Type**: Examples

**Description**: Provide example scripts for common use cases.

**Acceptance Criteria**:
- [ ] Example condition script: `should_clean.groovy`
- [ ] Example transformer script: `normalize_text.groovy`
- [ ] Example validator script: `validate_json.groovy`
- [ ] Example shell script: `format_markdown.sh`
- [ ] Scripts documented with comments
- [ ] Scripts tested and working

**Dependencies**: Task 1.2, Task 1.3

---

### Task 6.3: Update TDD if Needed
**Priority**: P2 | **Estimated**: 1h | **Type**: Documentation

**Description**: Update `docs/tdd.md` if any architectural decisions changed during implementation.

**Acceptance Criteria**:
- [ ] Review implementation against TDD
- [ ] Update TDD if gaps found
- [ ] Document any deviations from original plan
- [ ] Update constitution if needed

**Dependencies**: Implementation complete

---

## Task Summary

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| 0: Foundation | 3 | 3h |
| 1: External Tools | 4 | 9.5h |
| 2: Expression Resolution | 3 | 8h |
| 3: Workspace Init | 5 | 10h |
| 4: Cleanup | 4 | 7.5h |
| 5: Testing | 6 | 14h |
| 6: Documentation | 3 | 4.5h |
| **Total** | **28** | **56.5h** |

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
