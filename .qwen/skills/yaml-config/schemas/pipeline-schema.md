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
  batch: number              # Default: 10
  window: number       # Default: 5
  cooldown: duration               # Default: 5s
  override: boolean    # Default: false
  execution:
    mode: sequential|parallel     # Default: sequential
    concurrency: number       # Default: 4
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
  url: file|http  #uri: "file://src/main/input/documents?format=folder"
  variables:
    book_id: 123abc
```

### items (Exactly one of source|items required)

```yaml
items:
  type: chapter|paragraph|line|document|page
  extractor: string # Optional Groovy script path
```

### states

```yaml
states:
  - name: string           # Required - State identifier
    condition: string      # Optional - Groovy expression
    tools:
      - tool: string       # Tool name
        async: boolean     # Optional - Default: false
        output: string  # Optional - Defaults to tool name
        input: {}          # Optional - Input configuration
```

### listeners

```yaml
listeners:
  after:
    - tool: string
      async: boolean       # Optional
  finish:
    - tool: string
```

### fallback

```yaml
fallback:
  retry:
    max: number
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
