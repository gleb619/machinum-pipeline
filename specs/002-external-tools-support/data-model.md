# Data Model: External Tools & Workspace Management

**Feature**: `002-external-tools-support`
**Date**: 2026-03-25
**Phase**: 1 - Data Model Design

## Core Entities

### 1. ExternalTool (Abstract Base Class)

**Purpose**: Base contract for all external tool implementations

**Attributes**:
- `name: String` — Tool identifier
- `version: Version` — Tool version
- `runtime: String` — Execution runtime (shell, groovy, docker)
- `workDir: Path` — Working directory for execution
- `timeout: Duration` — Maximum execution time
- `retryPolicy: RetryPolicy` — Retry configuration
- `executionTarget: ExecutionTarget` — Target environment (local, remote, docker)
- `config: Map<String, Object>` — Tool-specific configuration

**Relationships**:
- Extends: `Tool` interface (Phase 1)
- Extended by: `ShellTool`, `GroovyScriptTool`

---

### 2. ShellTool

**Purpose**: Execute shell scripts with JSON I/O

**Attributes**:
- `scriptPath: Path` — Path to shell script
- `args: List<String>` — Command-line arguments (supports expressions)
- `environment: Map<String, String>` — Environment variables
- `interpreter: String` — Shell interpreter (default: "bash")

**Behavior**:
- `execute(JsonNode input, ToolContext context): JsonNode` — Run script with input
- `validateScript(): void` — Verify script exists and is executable
- `buildProcessBuilder(): ProcessBuilder` — Construct process with env/args

**Relationships**:
- Extends: `ExternalTool`
- Uses: `ProcessBuilder` (JDK)

---

### 3. GroovyScriptTool

**Purpose**: Execute Groovy scripts for conditions, transformers, validators

**Attributes**:
- `scriptPath: Path` — Path to Groovy script (.groovy)
- `binding: Binding` — Variable binding for script context
- `groovyShell: GroovyShell` — Script execution engine
- `returnType: Class<?>` — Expected return type (Boolean for conditions)
- `sandboxed: boolean` — Enable security sandbox (default: true)

**Behavior**:
- `execute(JsonNode input, ToolContext context): JsonNode` — Evaluate script
- `compileScript(): CompiledScript` — Pre-compile for caching
- `setBindingVariable(String name, Object value): void` — Add context variable

**Relationships**:
- Extends: `ExternalTool`
- Uses: `GroovyShell`, `Binding` (Groovy 4.0+)

---

### 4. ExpressionContext

**Purpose**: Hold all variables available for expression resolution

**Attributes**:
- `item: Item` — Current item being processed
- `text: String` — Current text content
- `index: int` — Item index in collection
- `textLength: int` — Character count
- `textWords: int` — Word count
- `textTokens: int` — Token count (CL100K_BASE)
- `aggregationIndex: int` — Window/aggregation index
- `aggregationText: String` — Aggregated result
- `runId: String` — Current run identifier
- `state: StateDescriptor` — Current state info
- `tool: ToolDescriptor` — Current tool info
- `retryAttempt: int` — Retry count
- `env: Map<String, String>` — Environment variables
- `variables: Map<String, Object>` — Pipeline variables
- `scripts: ScriptRegistry` — Script loader reference

**Behavior**:
- `getVariable(String name): Object` — Retrieve variable by name
- `setVariable(String name, Object value): void` — Add/update variable

**Relationships**:
- Used by: `ExpressionResolver`, `GroovyScriptTool`

---

### 5. GroovyExpressionResolver

**Purpose**: Resolve `{{...}}` expressions using Groovy engine

**Attributes**:
- `groovyShell: GroovyShell` — Shared shell instance
- `binding: Binding` — Context binding
- `timeout: Duration` — Max resolution time (default: 5s)
- `cache: Map<String, CompiledScript>` — Compiled script cache

**Behavior**:
- `resolveTemplate(String template, ExpressionContext ctx): Object` — Resolve `{{...}}`
- `supportsInlineExpression(String value): boolean` — Check if value contains `{{...}}`
- `compileExpression(String expression): CompiledScript` — Pre-compile expression
- `evaluateCompiled(CompiledScript script, Binding binding): Object` — Execute with timeout

**Relationships**:
- Implements: `ExpressionResolver` (Phase 1 interface)
- Uses: `ExpressionContext`, `GroovyShell`

---

### 6. WorkspaceLayout

**Purpose**: Define and validate workspace directory structure

**Constants**:
- `ROOT_CONFIG: String = "seed.yaml"`
- `TOOLS_CONFIG: String = ".mt/tools.yaml"`
- `SCRIPTS_DIR: String = ".mt/scripts"`
- `STATE_DIR: String = ".mt/state"`
- `INPUT_DIR: String = "src/main/chapters"`
- `MANIFEST_DIR: String = "src/main/manifests"`
- `OUTPUT_DIR: String = "build"`

**Behavior**:
- `validate(Path workspaceRoot): ValidationResult` — Check structure exists
- `createDirectories(Path workspaceRoot): void` — Initialize structure
- `getScriptPath(ScriptType type, String name): Path` — Resolve script location

**Relationships**:
- Used by: `WorkspaceInitializerTool`, `ShellTool`, `GroovyScriptTool`

---

### 7. WorkspaceInitializerTool

**Purpose**: Orchestrate workspace setup (download + bootstrap)

**Attributes**:
- `workspaceRoot: Path` — Root directory
- `toolsConfig: ToolsYaml` — Parsed tools.yaml
- `downloadOnly: boolean` — Skip bootstrap if true

**Behavior**:
- `install(): void` — Run full install (download + bootstrap)
- `download(): void` — Fetch tool sources without workspace mutation
- `bootstrap(): void` — Create directory structure and generate configs
- `generatePackageJson(): void` — Create package.json if node tools present
- `copyTemplate(String template, Path destination): void` — Generate config from template

**Relationships**:
- Uses: `WorkspaceLayout`, `ToolsYaml`
- Creates: `seed.yaml`, `.mt/tools.yaml`, `package.json`

---

### 8. CleanupPolicy

**Purpose**: Define retention rules for run cleanup

**Attributes**:
- `successRetention: Duration` — Keep successful runs for (default: 5d)
- `failedRetention: Duration` — Keep failed runs for (default: 7d)
- `maxSuccessfulRuns: int` — Retain latest N successful (default: 5)
- `maxFailedRuns: int` — Retain latest N failed (default: 10)

**Behavior**:
- `parse(String yaml): CleanupPolicy` — Parse from YAML config
- `shouldKeep(RunMetadata run, List<RunMetadata> allRuns): boolean` — Apply rules
- `getAge(Path runDir): Duration` — Calculate run age

**Relationships**:
- Used by: `CleanupCommand`
- Parsed from: Root config `body.cleanup` section

---

### 9. ScriptRegistry

**Purpose**: Locate and load scripts by type and name

**Attributes**:
- `scriptsDir: Path` — Base scripts directory (`.mt/scripts`)
- `subdirectories: Map<ScriptType, String>` — Type → subdir mapping

**Script Types**:
- `CONDITION` → "conditions"
- `TRANSFORMER` → "transformers"
- `VALIDATOR` → "validators"
- `LOADER` → "loaders"
- `EXTRACTOR` → "extractors"

**Behavior**:
- `getScript(ScriptType type, String name): Path` — Resolve script path
- `loadScript(Path scriptPath): String` — Read script content
- `evaluateCondition(String scriptName, Item item): boolean` — Run condition script

**Relationships**:
- Used by: `ExpressionContext`, `GroovyScriptTool`
- Referenced in expressions: `{{scripts.conditions.should_clean(item)}}`

---

## YAML Schema Extensions

### Tools YAML — External Tool Declaration

```yaml
body:
  tools:
    - name: md-formatter
      type: external
      runtime: shell
      source:
        type: file
        url: "{{ '/app/some-path/script.sh' args[0] }}"
      args:
        - "{{item.id}}"
      timeout: 30s
      config:
        work-dir: "{{rootDir}}"
        
    - name: custom-validator
      type: external
      runtime: groovy
      source:
        type: file
        url: ".mt/scripts/validators/custom-validator.groovy"
      config:
        threshold: 0.8
```

### Root YAML — Cleanup Policy

```yaml
body:
  cleanup:
    success: 5d
    failed: 7d
    success-runs: 5
    failed-runs: 10
```

---

## File Artifacts

### Generated Files (Workspace Init)

| File | Purpose | Template Location |
|------|---------|-------------------|
| `seed.yaml` | Root configuration | `conf/templates/seed.yaml.template` |
| `.mt/tools.yaml` | Tool definitions | `conf/templates/tools.yaml.template` |
| `package.json` | Node dependencies | Generated from tool list |
| `.mt/scripts/conditions/.gitkeep` | Script directories | N/A |
| `.mt/scripts/transformers/.gitkeep` | Script directories | N/A |
| `.mt/scripts/validators/.gitkeep` | Script directories | N/A |
| `src/main/chapters/.gitkeep` | Input directory | N/A |
| `src/main/manifests/.gitkeep` | Pipeline definitions | N/A |
| `build/.gitkeep` | Output directory | N/A |

### Checkpoint Extensions

No changes to checkpoint structure. External tools emit results same as internal tools.

---

## Validation Rules

### External Tool Validation
1. **Script existence**: Script file MUST exist at declared path
2. **Script permissions**: Shell scripts MUST be executable
3. **Timeout range**: Timeout MUST be between 1s and 300s
4. **Return type**: Condition scripts MUST return boolean
5. **JSON I/O**: Transformer scripts MUST return valid JSON

### Workspace Init Validation
1. **Idempotency**: Bootstrap MUST NOT overwrite existing files without `--force`
2. **Directory creation**: All directories MUST be created with proper permissions
3. **Template validation**: Templates MUST be valid YAML before writing

### Expression Resolution Validation
1. **Syntax check**: Expressions MUST match `{{...}}` pattern
2. **Timeout**: Resolution MUST complete within timeout (default: 5s)
3. **Null safety**: Undefined variables resolve to null (no exception)
4. **Type safety**: Method calls on null throw descriptive error

### Cleanup Validation
1. **Active run protection**: Running runs CANNOT be cleaned without `--force`
2. **Age calculation**: Age computed from run start time, not file mtime
3. **Count enforcement**: Count-based retention applied AFTER age-based

---

## Integration Points

### Phase 1 Components (Unchanged)
- `Tool` interface — Extended by external tools
- `PipelineStateMachine` — Executes external tools same as internal
- `CheckpointStore` — No changes required
- `ErrorHandler` — External tools use same retry strategies

### New Components
- `ExternalTool` — Base class in `core/src/main/java/machinum/tool/`
- `ShellTool` — Implementation in `core/src/main/java/machinum/tool/`
- `GroovyScriptTool` — Implementation in `core/src/main/java/machinum/tool/`
- `GroovyExpressionResolver` — In `core/src/main/java/machinum/expression/`
- `WorkspaceInitializerTool` — In `core/src/main/java/machinum/workspace/`
- `CleanupPolicy` — In `core/src/main/java/machinum/cleanup/`
- `InstallCommand` — In `cli/src/main/java/machinum/cli/`
- `CleanupCommand` — In `cli/src/main/java/machinum/cli/`

---

## Migration Notes

### From Phase 1 to Phase 2
- Existing internal tools continue to work without modification
- Expression resolution automatically upgrades to Groovy engine
- Old checkpoints remain compatible (no schema change)
- Workspace init can be run on existing projects (skips existing files)
