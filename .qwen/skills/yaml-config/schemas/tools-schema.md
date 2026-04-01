# Tools Schema Reference

## Required Fields

```yaml
version: 1.0.0          # Required - Schema version
type: tools              # Required - Must be "tools"
name: string             # Required - Toolset identifier
body: {}                 # Required - Tools configuration
```

## Body Schema

### execution-targets

```yaml
execution-targets:
  default: local|remote|docker
  targets:
    - name: string       # Target identifier
      type: local|remote|docker
      remote-host: string # For remote type
      docker-host: string # For docker type
```

### install (Optional)

```yaml
install:
  tools:
    - name: string
      phase: bootstrap_only|bootstrap_optional
      tool: string        # Internal tool name
```

### tools

```yaml
registry:
  - name: string         # Required - Tool identifier
    execution-target: string # Default: default from execution-targets
    config:
      # Tool-specific configuration
      input-schema: {}    # JSON Schema for external tools
      output-schema: {}   # JSON Schema for external tools
      any-key: any-value  # A @JsonAnySetter captor, that handle all values
```

## Tool Types

### Internal Tools (Java SPI)

```yaml
- name: translator
```

### External Shell Tools

```yaml
- name: md-formatter
  runtime: shell
  config:
    source:
      type: file
      url: "./.mt/scripts/formatter.sh"
    args:
      - "{{item.id}}"
    work-dir: "{{rootDir}}"
```

### External Docker Tools

```yaml
- name: embedding-generator
  config:
    model: bge-large
    dimension: 1024
    runtime: docker
    source:
      type: docker
      image: "registry.example.com/embedding:latest"
```

### Minimal Declaration

```yaml
- name: translator
  # Name resolves via SPI, all other fields use defaults
```

## Configuration Templates

### Cache Key Template

```yaml
cache:
  key: "{{tool.name}}:{{tool.version}}:{{sha256(input)}}"
```

### Input/Output Schema (JSON Schema)

```yaml
config:
  input-schema:
    type: object
    properties:
      content:
        type: string
        minLength: 1
    required: [content]
  output-schema:
    type: object
    properties:
      result:
        type: string
      confidence:
        type: number
        minimum: 0
        maximum: 1
```
