# CLI Commands: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)  
> **Related:** [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml), [Project Structure §1](project-structure.md#1-workspace-directory-structure)

## Command Reference

```
machinum
├── install [tool...]                    # Install tools from tools.yaml
│   ├── download                         # Fetch tool sources (no workspace mutation)
│   └── bootstrap                        # Create workspace structure and run install() on all tools
├── run [pipeline-name]                  # Execute pipeline
│   ├── --resume <run-id>                # Resume from checkpoint
│   └── --dry-run                        # Validate without executing
├── cleanup                              # Clear intermediate files/logs/runs
│   ├── --run-id <run-id>                # Clean specific run
│   └── --older-than <duration>          # Clean by age
├── serve                                # Start HTTP server
│   ├── --port 8080
│   └── --ui                             # Enable admin UI
├── mcp                                  # MCP mode
│   ├── --command                        # No daemon mode
│   └── --server                         # Server mode
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
2. **BOOTSTRAP** — Creates workspace structure, runs `install()` on each tool unconditionally

**Usage:**
```bash
# Full install (download + bootstrap)
machinum setup

# Download only (no workspace mutation)
machinum setup download

# Bootstrap only (create structure, run install scripts)
machinum setup bootstrap

# Install specific tools only
machinum install qwen-summary translator
```

**Tool Lifecycle Method:**
Each internal tool implements `void install(ExecutionContext context)` which runs unconditionally:
```java
public class QwenSummary implements InternalTool {
    @Override
    public void install(ExecutionContext context) throws Exception {
        // Downloads model, validates API keys, initializes cache
        // Runs during 'machinum setup' for every tool
    }
    
    @Override
    public ToolResult process(ExecutionContext context) throws Exception {
        // Runs during pipeline execution when tool is invoked
    }
}
```

See [YAML Schema §3.1](yaml-schema.md#31-tool-lifecycle) for lifecycle details.
