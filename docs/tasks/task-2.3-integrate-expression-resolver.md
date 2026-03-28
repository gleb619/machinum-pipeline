# Task: 2.3-integrate-expression-resolver

**Phase**: 2
**Priority**: P0
**Status**: `pending`
**Depends On**: Task 2.1, Task 2.2
**TDD Reference**: `docs/tdd.md`

---

## Description

Integrate the `DefaultExpressionResolver` with `ExpressionContext` into the `PipelineStateMachine` to replace the
deprecated temporary expression resolver. This task completes the expression resolution MVP by wiring up the new
Groovy-based resolver with full support for template expressions, environment variables, pipeline variables, and
script-based expressions.

---

## Acceptance Criteria

- [x] `PipelineStateMachine` receives `ExpressionResolver` dependency via constructor or builder
- [x] `ExpressionContext` is created and populated with all predefined variables before each state execution
- [x] Tool configs are resolved via expression resolver before execution (e.g., `{{item.id}}` in tool parameters)
- [x] State conditions are evaluated via expression resolver (e.g., `{{item.type == 'chapter'}}`)
- [x] Script-based expressions work in conditions (e.g., `{{scripts.conditions.is_valid()}}`)
- [x] Environment variables accessible via `env.VARIABLE_NAME`
- [x] Pipeline variables accessible via `variables.variableName`
- [x] Existing tests continue to pass after integration

---

## Implementation Notes

The current `PipelineStateMachine.processState()` method (lines 118-125) uses a deprecated temporary
`ExpressionResolver`:

```java
// TODO: replace with groovy expression resolver
@Deprecated(forRemoval = true)
ExpressionResolver resolver = new ExpressionResolver(context);

if(state.

condition() !=null&&!resolver.

evaluateCondition(state.condition())){
    log.

debug("Skipping state {} due to condition: {}",state.name(),state.

condition());
    return;
    }
```

This needs to be replaced with the new `DefaultExpressionResolver` that uses `ExpressionContext`:

```java
// Create ExpressionContext with all predefined variables
ExpressionContext exprContext = ExpressionContext.builder()
        .item(executionContext.get("item").orElse(null))
        .text(executionContext.get("text").orElse(""))
        .index(executionContext.get("index").orElse(0))
        .textLength(executionContext.get("textLength").orElse(0))
        .textWords(executionContext.get("textWords").orElse(0))
        .textTokens(executionContext.get("textTokens").orElse(0))
        .aggregationIndex(executionContext.get("aggregationIndex").orElse(0))
        .aggregationText(executionContext.get("aggregationText").orElse(null))
        .runId(executionContext.get("runId").orElse(""))
        .state(state)
        .tool(toolDef)
        .retryAttempt(executionContext.get("retryAttempt").orElse(0))
        .env(environmentVariables)
        .variables(pipelineVariables)
        .scripts(scriptRegistry)
        .build();

// Evaluate condition using new resolver
Object conditionResult = expressionResolver.resolveTemplate(state.condition(), exprContext);
if(state.

condition() !=null&&!Boolean.

parseBoolean(conditionResult.toString())){
    log.

debug("Skipping state {} due to condition: {}",state.name(),state.

condition());
    return;
    }
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` - Complete architecture and design
- **Expression Resolver**: `core/src/main/java/machinum/expression/DefaultExpressionResolver.java`
- **Expression Context**: `core/src/main/java/machinum/expression/ExpressionContext.java`
- **Script Registry**: `core/src/main/java/machinum/expression/ScriptRegistry.java`

**Files to Modify**:

- `core/src/main/java/machinum/pipeline/PipelineStateMachine.java` (lines 1-188)
- `core/src/main/java/machinum/pipeline/StateProcessor.java` (if used)

**Files to Read**:

- `core/src/main/java/machinum/expression/DefaultExpressionResolver.java` (lines 1-212)
- `core/src/main/java/machinum/expression/ExpressionContext.java` (lines 1-93)
- `core/src/main/java/machinum/pipeline/ExecutionContext.java` (lines 1-?)

---

## Spec

### Contracts

**PipelineStateMachine Constructor**:

```java
PipelineStateMachine.builder()
    .

pipeline(pipelineManifest)
    .

toolRegistry(toolRegistry)
    .

checkpointStore(checkpointStore)
    .

runLogger(runLogger)
    .

stepRunner(stepRunner)
    .

expressionResolver(expressionResolver)  // NEW: Add this
    .

build();
```

**ExpressionContext Creation**:

```java
ExpressionContext.builder()
    .

item(Map<String, Object>)
    .

text(String)
    .

index(int)
    .

textLength(int)
    .

textWords(int)
    .

textTokens(int)
    .

aggregationIndex(int)
    .

aggregationText(String)
    .

runId(String)
    .

state(StateDefinition)
    .

tool(ToolDefinition)
    .

retryAttempt(int)
    .

env(Map<String, String>)
    .

variables(Map<String, Object>)
    .

scripts(ScriptRegistry)
    .

build();
```

### Data Model

**ExpressionContext Fields**:

- `item`: Current item being processed (Map)
- `text`: Current text content
- `index`: Element index in collection
- `textLength`, `textWords`, `textTokens`: Text metrics
- `aggregationIndex`, `aggregationText`: Window/aggregation state
- `runId`: Run identifier
- `state`: Current state definition
- `tool`: Current tool definition
- `retryAttempt`: Current retry number
- `env`: Environment variables map
- `variables`: Pipeline variables map
- `scripts`: Script registry for script-based expressions

### Checklists

**Verification Commands**:

```bash
# Build the project
./gradlew build

# Run existing tests to ensure no regressions
./gradlew :core:test --tests "*PipelineStateMachine*"

# Run expression resolver tests
./gradlew :core:test --tests "*DefaultExpressionResolverTest*"

# Create and run integration test for Task 2.3
./gradlew :core:test --tests "*ExpressionResolverTest*"
```

### Plan

1. **Add ExpressionResolver dependency** to PipelineStateMachine builder
2. **Create ExpressionContext** at the start of each state processing
3. **Replace condition evaluation** to use new resolver with ExpressionContext
4. **Update tool config resolution** to use expression resolver for template strings
5. **Test manually** with a sample pipeline using expressions
6. **Verify all existing tests** still pass

### Quickstart

- `core/src/main/java/machinum/pipeline/PipelineStateMachine.java` - Main file to modify
- `core/src/main/java/machinum/expression/DefaultExpressionResolver.java` - Resolver implementation
- `core/src/main/java/machinum/expression/ExpressionContext.java` - Context model
- `core/src/main/java/machinum/expression/ScriptRegistry.java` - Script registry
- `core/src/test/java/machinum/expression/DefaultExpressionResolverTest.java` - Test examples

---

## TDD Approach

This project follows a **YAML-First Test-Driven Development** methodology:

### 1. Start with YAML Configuration

Create a test pipeline manifest that uses expression resolution:

```yaml
version: 1.0.0
type: pipeline
name: "expression-test-pipeline"
variables:
  book_name: "Test Book"
  version: 1
body:
  states:
    - name: PROCESS
      condition: "{{item.type == 'chapter'}}"
      tools:
        - tool: groovy-validator
          config:
            script: "{{scripts.validators.is_valid(item)}}"
```

### 2. Create Integration Test

Write a test that verifies expression resolution in pipeline execution:

```java

@Test
void testPipelineWithExpressionResolution() {
  // Create pipeline with expressions
  // Initialize ExpressionResolver with ScriptRegistry
  // Execute pipeline
  // Verify conditions evaluated correctly
  // Verify tool configs resolved
}
```

### 3. Implement Integration

- Wire up ExpressionResolver in PipelineStateMachine
- Create ExpressionContext with all variables
- Replace deprecated resolver usage

### 4. Iterate and Refine

- Fix any test failures
- Ensure backward compatibility
- Add error handling for expression resolution failures

---

## Result

Link to: `docs/results/2.3-integrate-expression-resolver.result.md`
