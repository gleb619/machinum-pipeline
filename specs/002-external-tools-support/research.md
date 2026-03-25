# Research: External Tools & Workspace Management

**Feature**: `002-external-tools-support`
**Date**: 2026-03-25
**Phase**: 0 - Technical Research

## Technical Investigation

### 1. External Tool Execution

#### Shell Tool Implementation
**Approach**: Use `ProcessBuilder` for shell script execution with JSON I/O
**Key considerations**:
- Timeout enforcement via `Process.waitFor(timeout, TimeUnit)`
- Exit code validation (0 = success, non-zero = failure)
- Stdout/stderr capture for structured logging
- Environment variable injection from tool config

**Reference implementation pattern**:
```java
ProcessBuilder pb = new ProcessBuilder("bash", scriptPath.toString(), args);
pb.redirectErrorStream(true);
pb.directory(workDir.toFile());
pb.environment().putAll(environment);
Process process = pb.start();
boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
```

#### Groovy Script Tool Implementation
**Approach**: Use `GroovyShell` with custom `Binding` for context variables
**Key considerations**:
- Script sandboxing for security (prevent System.exit, file access outside workspace)
- Binding predefined variables: `item`, `text`, `runId`, etc.
- Script compilation caching for performance
- Return type validation (boolean for conditions, JsonNode for transformers)

**Reference implementation pattern**:
```java
Binding binding = new Binding();
binding.setVariable("item", currentItem);
binding.setVariable("text", currentText);
binding.setVariable("env", System.getenv());
GroovyShell shell = new GroovyShell(binding);
Object result = shell.evaluate(scriptFile);
```

### 2. Workspace Initialization

#### Directory Structure
Based on TDD section 3, the workspace layout is:
```
work-directory/
├── seed.yaml                        # Root configuration
├── .mt/
│   ├── tools.yaml                   # Tool definitions
│   ├── scripts/
│   │   ├── conditions/
│   │   ├── transformers/
│   │   └── validators/
│   └── state/
├── src/main/
│   ├── chapters/
│   └── manifests/
└── build/
```

#### Installation Phases
1. **download**: Fetch tool sources from git/http/spi without workspace mutation
2. **bootstrap**: Create directory structure and generate default configs
3. **install**: Shortcut for download → bootstrap

#### Package.json Generation
Triggered when `tools.yaml` contains node-based tools in `install.tools` section:
```yaml
install:
  tools:
    - name: node-scaffold
      phase: bootstrap_optional
      tool: node-package-generator
```

### 3. Cleanup Command

#### Retention Policies
From TDD section 7.2:
- `cleanup.success: 5d` — Keep successful runs for 5 days
- `cleanup.failed: 7d` — Keep failed runs for 7 days
- `cleanup.success-runs: 5` — Keep latest 5 successful runs per pipeline
- `cleanup.failed-runs: 10` — Keep latest 10 failed runs per pipeline

#### Implementation Strategy
- Parse duration strings (e.g., "7d", "24h", "1w")
- Filter runs by status and age
- Apply count-based retention per pipeline
- Manual override via `--run-id` flag

### 4. Expression Resolution

#### Predefined Variables (TDD section 4.4)
| Variable           | Type            | Description                  |
|--------------------|-----------------|------------------------------|
| `item`             | Item            | Current source/items element |
| `text`             | String          | Content of current element   |
| `index`            | int             | Element index in collection  |
| `textLength`       | int             | Character count              |
| `textWords`        | int             | Word count                   |
| `textTokens`       | int             | Token count via CL100K_BASE  |
| `aggregationIndex` | int             | Index for window/aggregation |
| `aggregationText`  | String          | Window/aggregation result    |
| `runId`            | String          | Active run identifier        |
| `state`            | StateDescriptor | Current state descriptor     |
| `tool`             | ToolDescriptor  | Current tool descriptor      |
| `retryAttempt`     | int             | Current retry number         |

#### Expression Syntax
- Template resolution: `"{{expression}}"`
- Environment access: `"{{env.API_KEY}}"`
- Script invocation: `"{{scripts.conditions.should_clean(item)}}"`
- Method chaining: `"{{text.substring(0, 100)}}"`

#### Groovy Engine Integration
**Approach**: Use `GroovyShell` with secure base class
**Security considerations**:
- Restrict imports to safe packages
- Prevent reflection abuse
- Sandboxed class loading
- Timeout for long-running expressions

## Unknowns & Clarifications Needed

### CRITICAL
1. **Script security model**: What level of sandboxing is required for Groovy scripts? Should file system access be restricted to workspace only?
2. **Expression timeout**: Should expression resolution have a configurable timeout to prevent infinite loops?
3. **Node tools detection**: What criteria determine if a tool requires `package.json` generation? Tool type field or explicit flag?

### MEDIUM
4. **Shell interpreter**: Should shell tools default to `bash` or be configurable (sh, zsh, etc.)?
5. **Script path resolution**: Are script paths relative to workspace root or `.mt/` directory?
6. **Cleanup atomicity**: Should cleanup operations be atomic (all-or-nothing) or best-effort?

### LOW
7. **Workspace overwrite behavior**: Should `bootstrap` prompt before overwriting existing files or use a `--force` flag?
8. **Expression caching**: Should resolved expressions be cached within a run for performance?

## Dependencies Analysis

### Internal Dependencies
- **Phase 1 foundation**: Tool interface, error handling, checkpoint store
- **YAML parsing**: SnakeYAML for config loading
- **Logging**: SLF4J for structured output

### External Dependencies
- **Groovy 4.0+**: Already in TDD stack
- **ProcessBuilder**: JDK built-in
- **File I/O**: JDK NIO

### Blocking Issues
None identified. All required dependencies are available in Phase 1 foundation.

## Recommended Approach

### External Tools
1. Create `ExternalTool` abstract base class extending `Tool` interface
2. Implement `ShellTool` with ProcessBuilder
3. Implement `GroovyScriptTool` with GroovyShell and secure binding
4. Add script path validation at pipeline load time

### Workspace Init
1. Create `WorkspaceInitializerTool` service with download/bootstrap phases
2. Use template files for default configs (seed.yaml, tools.yaml)
3. Generate package.json only when node tools are explicitly declared

### Cleanup
1. Implement `CleanupPolicy` parser for duration strings
2. Create `RunScanner` to enumerate runs by age/status
3. Apply retention rules in order: age-based, then count-based

### Expression Resolution
1. Replace temporary resolver with `GroovyExpressionResolver`
2. Pre-populate binding with all predefined variables
3. Add expression timeout (default: 5 seconds)
4. Cache compiled scripts for repeated evaluations

## Risk Assessment

| Risk                          | Likelihood | Impact | Mitigation                                                           |
|-------------------------------|------------|--------|----------------------------------------------------------------------|
| Groovy security vulnerability | Medium     | High   | Sandboxed class loader, restricted imports                           |
| Shell injection via args      | Medium     | High   | Validate/sanitize all arguments before passing to ProcessBuilder     |
| Expression infinite loop      | Low        | Medium | Timeout enforcement, max iteration count                             |
| Workspace init race condition | Low        | Low    | File locking, atomic directory creation                              |
| Cleanup deletes active run    | Low        | High   | Validate run status before deletion, require --force for active runs |

## Next Steps

1. **Clarify** security model for Groovy scripts
2. **Clarify** script path resolution rules
3. **Plan** implementation phases with tech stack confirmation
4. **Analyze** code changes required in existing modules
5. **Task** breakdown for implementation
