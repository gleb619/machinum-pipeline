# Pipeline Schema Reference

## Required Fields

```yaml
version: 1.0.0          # Required - Schema version
type: pipeline           # Required - Must be "pipeline"
name: string             # Required - Pipeline identifier
body: {}                 # Required - Pipeline configuration
```

## Body Schema

### config

```yaml
config:
  batch-size: number              # Default: 10
  window-batch-size: number       # Default: 5
  cooldown: duration               # Default: 5s
  allow-override-mode: boolean    # Default: false
  execution:
    mode: sequential|parallel     # Default: sequential
    max-concurrency: number       # Default: 4
    runner:
      type: one_step|batch_step|batch_step_over
```

### variables

```yaml
variables:
  key: value              # String or array
  genres: [game, fantasy] # List form accepted
```

### source (Exactly one of source|items required)

```yaml
source:
  type: file|http|git|s3
  file-location: string
  format: md|json|jsonl|pdf|docx
  custom-loader: string   # Optional Groovy script path
```

### items (Exactly one of source|items required)

```yaml
items:
  type: chapter|paragraph|line|document|page
  custom-extractor: string # Optional Groovy script path
```

### states

```yaml
states:
  - name: string           # Required - State identifier
    condition: string      # Optional - Groovy expression
    tools:
      - tool: string       # Tool name
        async: boolean     # Optional - Default: false
        output-key: string  # Optional - Defaults to tool name
        input: {}          # Optional - Input configuration
```

### listeners

```yaml
listeners:
  on_item_complete:
    - tool: string
      async: boolean       # Optional
  on_pipeline_complete:
    - tool: string
```

### error-handling

```yaml
error-handling:
  default-strategy: retry|skip|stop|fallback
  retry-config:
    max-attempts: number
    backoff: fixed|linear|exponential
  strategies:
    - exception: string     # Regex pattern
      strategy: retry|skip|stop|fallback
```

## Expression Syntax

Use `{{ variable }}` for template expressions:

- `{{item.content}}` - Current item content
- `{{previous.tool_name}}` - Output from previous tool
- `{{env.VARIABLE}}` - Environment variable
- `{{scripts.path/to/script.groovy}}` - External script
