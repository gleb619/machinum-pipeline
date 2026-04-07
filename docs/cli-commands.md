# CLI Commands: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)  
> **Related:** [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml), [Project Structure §1](project-structure.md#1-workspace-directory-structure)

## Command Reference

```
machinum
├── setup [tool...]                      # Install tools from tools.yaml
│   ├── download                         # Fetch tool sources (no workspace mutation)
│   └── bootstrap                        # Create workspace structure and run install() on all tools
├── run [pipeline-name]                  # Execute pipeline
│   ├── --resume <run-id>                # Resume from checkpoint
│   └── --dry-run                        # Validate without executing
├── cleanup                              # Clear intermediate files/logs/runs
│   ├── --run-id <run-id>                # Clean specific run
│   └── --older-than <duration>          # Clean by age
├── serve                                # Start HTTP server
│   ├── --port 7070
│   └── --ui                             # Enable admin UI
├── status                               # Show app status
│   └── --run-id <run-id>
├── logs                                 # Show app logs
│   └── --run-id <run-id>
└── help
```

## Command Details

### `install`

Installs tools by running the `install()` lifecycle method on all internal tools defined in `.mt/tools.yaml`.

**Lifecycle:**
1. **DOWNLOAD** — Fetches tool sources (git, http, file); does NOT mutate workspace
2. **BOOTSTRAP** — Creates workspace structure, runs `bootstrap()` on tools listed in `tools.yaml -> body.bootstrap` (ordered by `dependsOn` and `priority`)

**Usage:**
```bash
# Full install (download + bootstrap)
machinum setup

# Download only (no workspace mutation)
machinum setup download

# Bootstrap only (create structure, run bootstrap scripts)
machinum setup bootstrap

# Install specific tools only
machinum install qwen-summary translator

# Try with examples folder
./gradlew :cli:run --args="setup -w ./examples/sample-test"
./gradlew :cli:run --args="setup download -w ./examples/expression-test"
./gradlew :cli:run --args="setup bootstrap -w ./examples/sample-test"

# Setup sample-test (copies sample chapters from resources)
./gradlew :cli:run --args="setup -w ./examples/sample-test"

# Setup on empty folder (no manifests - defaults applied)
./gradlew :cli:run --args="setup -w ./examples/fully-empty-folder"
```

**Empty Folder Behavior:**

When running `setup` on a workspace with no manifest files:
- Missing `seed.yaml` → Default empty root config applied via [`Executor.setDefaults()`](../core/src/main/java/machinum/executor/Executor.java#L72-L91)
- Missing `.mt/tools.yaml` → Default empty tools config applied
- Workspace structure created: `.mt/`, `src/main/chapters/`, `src/main/manifests/`, `build/`
- No errors - setup completes successfully with defaults

This allows you to start with an empty directory and add manifests incrementally. See [`examples/fully-empty-folder/`](../examples/fully-empty-folder/) for a complete example.

**Tool Lifecycle Method:**
Each tool implements `void bootstrap(ExecutionContext context)` which runs unconditionally:
```java
public class QwenSummary implements Tool {
    @Override
    public void bootstrap(ExecutionContext context) throws Exception {
        // Downloads model, validates API keys, initializes cache
        // Runs during 'machinum setup' for every tool
    }

    @Override
    public ToolResult execute(ExecutionContext context) {
        // Runs during pipeline execution when tool is invoked
    }
}
```

**GitTool Example:**
The `git` tool demonstrates the bootstrap/execute lifecycle:
- **Bootstrap:** Initializes Git repository, creates `.githooks/commit-msg.sh`
- **Execute:** Creates commits with GitLab convention messages

```java
public class GitTool implements Tool {
    @Override
    public void bootstrap(BootstrapContext context) throws Exception {
        // Initialize git repository in workspace
        // Create .githooks/commit-msg.sh hook
    }

    @Override
    public ToolResult execute(ExecutionContext context) {
        // Create commit with message from context
        String message = context.getVariable("commitMessage", "feat: update");
        // git.commit().setMessage(message).call();
    }
}
```

See [YAML Schema §3.1](yaml-schema.md#31-tool-lifecycle) for lifecycle details.
See [GitTool](../tools/external/src/main/java/machinum/tool/GitTool.java) for implementation example.

---

## Built-in Mode Flags

| Method              | Example                                                              |
|---------------------|----------------------------------------------------------------------|
| **Gradle property** | `./gradlew :cli:run --args="setup -w ./" -PbuiltinToolsEnabled=true` |
| **Environment var** | `MT_BUILTIN_TOOLS_ENABLED=true machinum setup -w ./my-project`       |
| **System property** | `java -Dmachinum.builtin.tools=true -jar cli.jar setup`              |
| **Auto-detect**     | Running from project root with `build.gradle` → builtin mode         |

See [Project Structure §3.1](project-structure.md#31-built-in-mode-gradle-configuration) for
Gradle configuration details,
[YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml) for registry configuration.
