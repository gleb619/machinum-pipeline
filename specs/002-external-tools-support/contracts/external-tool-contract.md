# External Tool Contract: 002-external-tools-support

## ShellTool Contract

### `ShellTool.execute(JsonNode input, ToolContext context): JsonNode`
- **Purpose**: Execute shell script with JSON I/O
- **Input**:
  - `input` — JSON object passed to script via stdin
  - `context` — Tool context with config, workDir, timeout
- **Output**: JSON object parsed from script stdout
- **Failure Contract**:
  - non-zero exit code → tool execution failure
  - timeout exceeded → process terminated, TimeoutException thrown
  - invalid JSON output → parse error with stdout snippet
- **Behavioral Guarantees**:
  - Script receives JSON via stdin
  - Script stdout must be valid JSON
  - Stderr logged but doesn't cause failure
  - Working directory set from config
  - Environment variables injected from config

---

## GroovyScriptTool Contract

### `GroovyScriptTool.execute(JsonNode input, ToolContext context): JsonNode`
- **Purpose**: Evaluate Groovy script with context binding
- **Input**:
  - `input` — JSON object available as `input` variable in script
  - `context` — Tool context with script path, binding config
- **Output**: Script return value (converted to JsonNode if needed)
- **Failure Contract**:
  - compilation error → GroovyCompilationException with error details
  - runtime exception → GroovyRuntimeException with stack trace
  - timeout exceeded → TimeoutException, script interrupted
  - return type mismatch (for conditions) → TypeValidationException
- **Behavioral Guarantees**:
  - Predefined variables available: `item`, `text`, `runId`, etc.
  - Environment variables available via `env.MAP`
  - Scripts sandboxed by default (no System.exit, restricted imports)
  - Compiled scripts cached for performance

---

## ExpressionResolver Contract

### `GroovyExpressionResolver.resolveTemplate(String template, ExpressionContext ctx): Object`
- **Purpose**: Resolve `{{...}}` expressions using Groovy engine
- **Input**:
  - `template` — String containing `{{expression}}` syntax
  - `ctx` — Expression context with all predefined variables
- **Output**: Resolved value (String, Boolean, Number, or Object)
- **Failure Contract**:
  - syntax error → ExpressionSyntaxException with failed expression
  - timeout exceeded → TimeoutException (default: 5s)
  - undefined variable → resolves to null (no exception)
  - method call on null → NullPointerException with context
- **Behavioral Guarantees**:
  - All predefined variables from ExpressionContext available
  - Environment variables accessible via `env.VARIABLE_NAME`
  - Script calls via `scripts.type.name(args)` supported
  - Method chaining supported: `text.substring(0, 100).trim()`
  - Expressions compiled and cached for reuse

---

## WorkspaceInitializerTool Contract

### `WorkspaceInitializerTool.install(): void`
- **Purpose**: Full workspace initialization (download + bootstrap)
- **Input**: None (uses configured workspace root)
- **Output**: Workspace structure created on filesystem
- **Failure Contract**:
  - existing files without --force → SkipException with file list
  - template not found → TemplateNotFoundException
  - permission denied → IOException with path details
- **Behavioral Guarantees**:
  - Idempotent: skips existing files without --force
  - Creates all required directories
  - Generates seed.yaml and .mt/tools.yaml from templates
  - Generates package.json only if node tools declared

### `WorkspaceInitializerTool.download(): void`
- **Purpose**: Fetch tool sources without workspace mutation
- **Behavioral Guarantees**:
  - Does NOT create directories
  - Does NOT modify existing files
  - Fetches tools from git/http/spi sources defined in tools.yaml

### `WorkspaceInitializerTool.bootstrap(): void`
- **Purpose**: Create workspace structure and generate configs
- **Behavioral Guarantees**:
  - Creates: `.mt/`, `src/main/chapters/`, `src/main/manifests/`, `build/`
  - Creates script subdirectories: `conditions/`, `transformers/`, `validators/`
  - Generates .gitkeep files in empty directories
  - Skips existing files without --force flag

---

## CleanupPolicy Contract

### `CleanupPolicy.shouldKeep(RunMetadata run, List<RunMetadata> allRuns): boolean`
- **Purpose**: Determine if run should be retained based on policy
- **Input**:
  - `run` — Run metadata with status and start time
  - `allRuns` — All runs for count-based retention
- **Output**: true if run should be kept, false if eligible for cleanup
- **Behavioral Guarantees**:
  - Age-based rules applied first (successRetention, failedRetention)
  - Count-based rules applied second (maxSuccessfulRuns, maxFailedRuns)
  - Count-based retention per pipeline, not global
  - Active runs always kept unless --force used

---

## CLI Command Contracts

### `machinum install [download|bootstrap] [--force] [--workspace <path>]`
- **Purpose**: Initialize workspace
- **Subcommands**:
  - `download` — Fetch tool sources only
  - `bootstrap` — Create structure only
  - (none) — Run both in sequence
- **Options**:
  - `--force` — Overwrite existing files
  - `--workspace <path>` — Specify workspace root
- **Failure Contract**:
  - tools.yaml not found for download → non-zero exit
  - template missing → non-zero exit
- **Output**: Progress logging and completion summary

### `machinum cleanup --run-id <id> | --older-than <duration> [--force] [--dry-run]`
- **Purpose**: Clean up old run states
- **Options**:
  - `--run-id <id>` — Clean specific run (mutually exclusive with --older-than)
  - `--older-than <duration>` — Clean runs older than duration (e.g., "7d", "24h")
  - `--force` — Allow cleaning active runs
  - `--dry-run` — Preview without deleting
- **Failure Contract**:
  - unknown run-id → non-zero exit
  - invalid duration format → non-zero exit
  - active run without --force → non-zero exit
- **Output**: Summary of runs cleaned and retained

---

## Script Path Resolution Contract

### `ScriptRegistry.getScript(ScriptType type, String name): Path`
- **Purpose**: Resolve script path by type and name
- **Input**:
  - `type` — Script type (CONDITION, TRANSFORMER, VALIDATOR, LOADER, EXTRACTOR)
  - `name` — Script name without extension
- **Output**: Absolute path to script file
- **Failure Contract**:
  - script not found → ScriptNotFoundException with expected path
  - invalid type → IllegalArgumentException
- **Behavioral Guarantees**:
  - Paths resolved relative to workspace root
  - Script subdirectory determined by type
  - Extension `.groovy` or `.sh` appended based on runtime

---

## Behavioral Guarantees (System-Level)

- External tools integrate seamlessly with existing Tool interface
- External tools honor timeout and retry configuration
- External tools emit structured logs with correlation IDs
- Expression resolution completes within timeout for all expressions
- Workspace init is idempotent without --force flag
- Cleanup respects retention policies from root config
- All contracts are technology-agnostic (implementation detail)
