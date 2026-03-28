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
tools:
  - name: string         # Required - Tool identifier
    type: internal|external  # Default: internal
    version: string       # Default: latest
    execution-target: string # Default: default from execution-targets
    runtime: shell|docker  # For external tools
    source:
      type: spi|git|http|file|docker
      url: string         # For git/http/file
      spi-class: string   # For spi type
      image: string       # For docker type
      git-tag: string     # For git type
    args: []             # Optional - Script arguments
    cache:
      enabled: boolean    # Default: true
      key: string         # Cache key template
      ttl: duration       # Default: 24h
    timeout: duration     # Default: 30s
    config:
      # Tool-specific configuration
      model: string
      temperature: number
      input-schema: {}    # JSON Schema for external tools
      output-schema: {}   # JSON Schema for external tools
```

## Tool Types

### Internal Tools (Java SPI)

```yaml
- name: translator
  type: internal
  source:
    type: spi
    spi-class: machinum.tools.Translator
```

### External Shell Tools

```yaml
- name: md-formatter
  type: external
  runtime: shell
  source:
    type: file
    url: "./.mt/scripts/formatter.sh"
  args:
    - "{{item.id}}"
  config:
    work-dir: "{{rootDir}}"
```

### External Docker Tools

```yaml
- name: embedding-generator
  type: external
  runtime: docker
  source:
    type: docker
    image: "registry.example.com/embedding:latest"
  config:
    model: bge-large
    dimension: 1024
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
