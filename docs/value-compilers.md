# Value Compilers: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Overview

The Value Compilers system transforms YAML manifest POJOs (with raw `String` values) into compiled POJOs with lazy expression evaluation support. This enables Groovy expressions like `{{ item.name }}` to be evaluated at runtime with the correct execution context.

### 1.1 Problem Statement

YAML manifests contain values that may include Groovy expressions:

```yaml
name: GLOSSARY_CONSOLIDATION
condition: "{{ consolidated_glossary.size() > 0 }}"
tools:
  - tool: glossary-deduplicator
    input: "{{consolidated_glossary}}"
    output: final_glossary
```

Without compilation, these expressions would need to be resolved manually at every usage point. The compiler system:
- Wraps expression-containing values in `Compiled<T>` suppliers
- Binds the expression context at compile time
- Enables lazy evaluation via `get()` method calls

### 1.2 Architecture

```
YAML File → SnakeYAML → Raw POJO → Compiler → Compiled POJO
                                              ↓
                                    Compiled<T> wrappers
                                              ↓
                                    Lazy evaluation via get()
```

---

## 2. Core Types

### 2.1 `Compiled<T>`

**Location:** `core/src/main/java/machinum/compiler/Compiled.java`

A lazy-evaluating wrapper implementing `Supplier<T>`:

```java
public class Compiled<T> implements Supplier<T> {
    
    // Evaluation
    @Override
    public T get();  // Evaluates expression or returns constant
    
}
```

**Usage:**
```java
// Expression value - evaluated on get()
Compiled<String> condition = Compiled.of("{{ item.size() > 0 }}", ctx, resolver);
boolean result = (Boolean) condition.get();  // Evaluates Groovy

// Constant value - no evaluation overhead
Compiled<String> name = Compiled.ofConstant("static-name");
String value = name.get();  // Returns "static-name" directly
```

### 2.2 `CompiledMap`

**Location:** `core/src/main/java/machinum/compiler/CompiledMap.java`

Wrapper for maps whose values may contain expressions:

```java
public class CompiledMap implements Supplier<Map<String, Object>> {
    public static CompiledMap of(Map<String, Object> raw, ExpressionContext ctx, ExpressionResolver resolver);
    
    public Object get(String key);
    public <T> T get(String key, Class<T> type);
    public Map<String, Object> get();  // Evaluates all values
    
}
```

### 2.3 `CompilationContext`

**Location:** `core/src/main/java/machinum/compiler/CompilationContext.java`

Holds shared state during compilation:

```java
public class CompilationContext {
    private ExpressionResolver resolver;
    private ScriptRegistry scriptRegistry;
    private Map<String, Object> variables;
    private Map<String, String> environment;
    private String runId;
}
```

---

## 3. Available Compilers

| YAML Model         | Compiler Class                                             | Compiled Output            | Location                                |
|--------------------|------------------------------------------------------------|----------------------------|-----------------------------------------|
| `ToolDefinition`   | [`ToolDefinitionCompiler`](#31-tooldefinitioncompiler)     | `CompiledToolDefinition`   | `core/src/main/java/machinum/compiler/` |
| `StateDefinition`  | [`StateDefinitionCompiler`](#32-statedefinitioncompiler)   | `CompiledStateDefinition`  | `core/src/main/java/machinum/compiler/` |
| `PipelineManifest` | [`PipelineManifestCompiler`](#33-pipelinemanifestcompiler) | `CompiledPipelineManifest` | `core/src/main/java/machinum/compiler/` |
| `RootManifest`     | [`RootManifestCompiler`](#34-rootmanifestcompiler)         | `CompiledRootManifest`     | `core/src/main/java/machinum/compiler/` |
| `ToolsManifest`    | [`ToolsManifestCompiler`](#35-toolsmanifestcompiler)       | `CompiledToolsManifest`    | `core/src/main/java/machinum/compiler/` |

### 3.1 ToolDefinitionCompiler

**Source:** `machinum.manifest.PipelineToolManifest`  
**Compiled:** `machinum.compiler.ToolDefinition`

```java
public record ToolDefinition(
    String name,        // → Compiled<String>
    String type,        // → Compiled<String>
    String description, // → Compiled<String>
    Map<String, Object> toolConfig,  // → CompiledMap
    String script       // → Compiled<String>
)
```

**Example:**
```yaml
# YAML
- tool: translator
  config:
    model: "{{env.TRANSLATION_MODEL}}"
    temperature: 0.7
```

```java
// Compiled
CompiledToolDefinition tool = compiler.compile(toolDef, ctx);
String name = tool.getNameValue();  // "translator"
Map<String, Object> config = tool.getToolConfigValue();  // {model="gpt-4", temperature=0.7}
```

### 3.2 StateDefinitionCompiler

**Source:** `machinum.manifest.PipelineStateManifest`  
**Compiled:** `machinum.compiler.CompiledStateDefinition`

```java
public record StateDefinition(
    String name,           // → Compiled<String>
    String description,    // → Compiled<String>
    String condition,      // → Compiled<String> (CRITICAL)
    List<ToolDefinition> tools,  // → List<CompiledToolDefinition>
    Map<String, Object> config   // → CompiledMap
)
```

**Example:**
```yaml
# YAML
- name: TRANSLATE
  condition: "{{ item.lang != 'en' }}"
  tools:
    - tool: translator
```

```java
// Compiled
CompiledStateDefinition state = compiler.compile(stateDef, ctx);
boolean shouldRun = state.evaluateCondition();  // Evaluates Groovy expression
```

### 3.3 PipelineManifestCompiler

**Source:** `machinum.manifest.PipelineManifest`  
**Compiled:** `machinum.compiler.PipelineDefinition`

```java
public record PipelineManifest(
    String name,                    // → Compiled<String>
    String description,             // → Compiled<String>
    Map<String, Object> config,     // → CompiledMap
    SourceOrItems sourceOrItems,    // → CompiledSourceOrItems
    List<StateDefinition> states,   // → List<CompiledStateDefinition>
    List<String> listeners          // → List<Compiled<String>>
)
```

### 3.4 RootManifestCompiler

**Source:** `machinum.manifest.RootManifest`  
**Compiled:** `machinum.compiler.RootDefinition`

```java
public record RootManifest(
    String name,                // → Compiled<String>
    String version,             // → Compiled<String>
    String description,         // → Compiled<String>
    Map<String, Object> config, // → CompiledMap
    Map<String, Object> env     // → CompiledMap
)
```

### 3.5 ToolsManifestCompiler

**Source:** `machinum.manifest.ToolsManifest`  
**Compiled:** `machinum.compiler.ToolsDefinition`

```java
public record ToolsManifest(
    String name,                // → Compiled<String>
    String version,             // → Compiled<String>
    List<ToolDefinition> tools, // → List<CompiledToolDefinition>
    Map<String, Object> config  // → CompiledMap
)
```

---

## 4. Usage Examples

### 4.1 Loading a Compiled Pipeline

```java
// Setup compilation context
CompilationContext ctx = CompilationContext.builder()
    .resolver(expressionResolver)
    .scriptRegistry(scriptRegistry)
    .variables(pipelineVariables)
    .environment(envVars)
    .runId(runId)
    .build();

// Load and compile
YamlManifestLoader loader = YamlManifestLoader.builder()
    .objectMapper(objectMapper)
    .yaml(new Yaml())
    .build();

CompiledPipelineManifest pipeline = loader.loadCompiledPipelineManifest(
    Paths.get("src/main/manifests/pipeline.yaml"), ctx);

// Use compiled pipeline
for (CompiledStateDefinition state : pipeline.getPipelineStates()) {
    if (state.evaluateCondition()) {
        // Process state tools
        for (CompiledToolDefinition tool : state.getStateTools()) {
            String toolName = tool.getNameValue();
            // ... execute tool
        }
    }
}
```

### 4.2 Expression Evaluation Flow

For the YAML:
```yaml
condition: "{{ consolidated_glossary.size() > 0 }}"
tools:
  - tool: glossary-deduplicator
    input: "{{consolidated_glossary}}"
```

**Compilation:**
1. `PipelineManifestCompiler` creates `CompiledPipelineManifest`
2. Delegates to `StateDefinitionCompiler` for each state
3. `StateDefinitionCompiler`:
   - Wraps `condition` in `Compiled<String>`
   - Delegates to `ToolDefinitionCompiler` for tools
4. `ToolDefinitionCompiler`:
   - Wraps `input` config value in `Compiled<String>`

**Runtime:**
```java
// Condition check
if (state.condition().get()) {  // Evaluates: consolidated_glossary.size() > 0
    // Tool execution
    Compiled<String> input = tool.getToolConfig().get("input");
    String inputValue = (String) input.get();  // Evaluates: {{consolidated_glossary}}
}
```

### 4.3 Context Updates

Compiled values can be re-evaluated with different contexts:

```java
// Compile once
Compiled<String> expr = Compiled.of("{{ item.name }}", initialCtx, resolver);

// Evaluate with different items
for (Map<String, Object> item : items) {
    ExpressionContext itemCtx = initialCtx.toBuilder().item(item).build();
    Compiled<String> rebound = expr.withContext(itemCtx);
    String name = (String) rebound.get();
}
```

---

## 5. Compiler Interface

All compilers implement the common interface:

```java
public interface YamlCompiler<SOURCE, COMPILED> {
    COMPILED compile(SOURCE source, CompilationContext ctx);
    boolean supports(Class<?> type);
}
```

### 5.1 Implementing a Custom Compiler

```java
public class CustomModelCompiler implements YamlCompiler<CustomModel, CompiledCustomModel> {
    
    @Override
    public CompiledCustomModel compile(CustomModel source, CompilationContext ctx) {
        ExpressionContext exprCtx = createExpressionContext(ctx);
        ExpressionResolver resolver = ctx.getResolver();
        
        Compiled<String> field1 = Compiled.of(source.getField1(), exprCtx, resolver);
        CompiledMap field2 = CompiledMap.of(source.getField2(), exprCtx, resolver);
        
        return new CompiledCustomModel(field1, field2);
    }
    
    @Override
    public boolean supports(Class<?> type) {
        return CustomModel.class.isAssignableFrom(type);
    }
    
    private ExpressionContext createExpressionContext(CompilationContext ctx) {
        return ExpressionContext.builder()
            .variables(ctx.getVariables())
            .env(ctx.getEnvironment())
            .runId(ctx.getRunId())
            .scripts(ctx.getScriptRegistry())
            .build();
    }
}
```

---

## 6. Performance Considerations

### 6.1 Lazy vs Eager Evaluation

**Lazy (Default):**
- Expressions evaluated on `get()` call
- Context can be updated between evaluations
- Overhead: ~1-2ms per evaluation (Groovy parsing cached)

**Eager (Constant):**
- Non-expression values wrapped as constants
- No evaluation overhead
- Used automatically for plain strings

### 6.2 Context Binding

Each `Compiled` captures its `ExpressionContext` at creation:
- **Pro:** Thread-safe, no external state needed
- **Con:** Must create new `Compiled` for context changes

Use `withContext()` for re-evaluation with different contexts instead of recompiling.

### 6.3 Memory Usage

| Component               | Memory Overhead            |
|-------------------------|----------------------------|
| `Compiled` (constant)   | ~32 bytes                  |
| `Compiled` (expression) | ~64 bytes + raw string     |
| `CompiledMap`           | ~48 bytes + entry overhead |

For large manifests (1000+ states/tools), expect ~10-20MB heap usage for compiled structures.

---

## 7. Integration Points

### 7.1 YamlManifestLoader

```java
// Raw loading (legacy)
PipelineManifest raw = loader.loadPipelineManifest(path);

// Compiled loading (recommended)
CompiledPipelineManifest compiled = loader.loadCompiledPipelineManifest(path, ctx);
```

### 7.2 StateRunner

```java
public interface StateRunner {
    void executeState(
        CompiledStateDefinition state,  // Changed from StateDefinition
        int stateIndex,
        String itemId,
        ExecutionContext context);
}
```

### 7.3 StateProcessor

```java
public void processTools(
    List<CompiledToolDefinition> tools,  // Changed from ToolDefinition
    String stateName,
    String itemId,
    ExecutionContext context)
```

---

## 8. Migration Guide

### 8.1 From Raw POJOs to Compiled

**Before:**
```java
public void process(StateDefinition state, ExpressionContext ctx) {
    if (state.condition() != null) {
        Object result = expressionResolver.resolveTemplate(state.condition(), ctx);
        // ...
    }
}
```

**After:**
```java
public void process(CompiledStateDefinition state, ExpressionContext ctx) {
    if (state.condition() != null) {
        Object result = state.condition().get();  // Context already bound
        // ...
    }
}
```

### 8.2 ExpressionContext Changes

The `ExpressionContext` now uses compiled types:

```java
// Before
private final StateDefinition state;
private final ToolDefinition tool;

// After
private final CompiledStateDefinition state;
private final CompiledToolDefinition tool;
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-03-28  
**Status:** Implementation Complete
