# CLI Commands: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## Command Reference

```
machinum
├── install [tool...]                    # Install tools from tools.yaml
│   ├── download                         # Fetch tool sources (no workspace mutation)
│   └── bootstrap                        # Create workspace structure and run install scripts
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
