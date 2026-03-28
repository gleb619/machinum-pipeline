---
name: yaml-config
description: Work with YAML configuration files for Machinum Pipeline including pipelines, tools, and root configs. Use when creating, modifying, or validating YAML files.
---

# YAML Configuration Skill

## Instructions

Work with the project's YAML schema following the patterns defined in `docs/tdd.md:77-445`. All YAML files share a
common base structure.

### Common Base Structure

All YAML files use this unified format:

```yaml
version: 1.0.0
type: pipeline|tools|root     # Discriminator
name: string
description: string           # Optional
labels:
  key: value
metadata:
  author: string
  created: timestamp
body: {}                      # Type-specific payload
```

### Root Configuration (`root.yml` or `seed.yaml`)

Global runtime defaults and references:

```yaml
version: 1.0.0
type: root
name: "Book Processing Runtime Config"
description: "Global runtime defaults and references"
body:
  tools: ".mt/tools.yaml"        # default
  metadata:
    book_id: my_book_123
  execution:
    parallel: false              # default
    max-concurrency: 4           # default
    resume: true                 # default
    manifest-snapshot:
      enabled: true              # default
      mode: copy                 # copy|reference; default: copy
  error-handling:
    retry:
      max-attempts: 3
      backoff:
        type: fixed              # fixed|linear|exponential; default: fixed
        initial-delay: 2s
        max-delay: 30s
        multiplier: 2.0
        jitter: 0.15
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: "ValidationException"
        strategy: skip
      - exception: ".*"
        strategy: stop
  env-files:
    - ".env"
    - ".ENV"
  env:
    API_KEY: "{{env.OPENAI_KEY}}"
    AWS_REGION: us-east-1
```

### Tools Configuration (`.mt/tools.yaml`)

Tool definitions and execution targets:

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
description: "AI and utility tools"
body:
  execution-targets:
    default: local               # local|remote|docker
    targets:
      - name: local
        type: local
      - name: remote-build
        type: remote
        remote-host: build.example.internal

  tools:
    - name: qwen-summary
      type: internal             # internal|external; default: internal
      execution-target: local
      source:
        type: spi                # spi|git|http|file; default: spi
      config:
        model: qwen2.5-72b
        temperature: 0.7
        input-schema:            # JSON Schema; validation for external tools only
          type: object
          properties:
            content: { type: string }
        output-schema:
          type: object
          properties:
            summary: { type: string }

    - name: translator
      # Minimal declaration — name resolves via SPI
```

### Pipeline Declaration (`src/main/manifests/pipeline.yaml`)

**Constraint**: Exactly one of `source` or `items` must be declared.

```yaml
version: 1.0.0
type: pipeline
name: "complex-pipeline"
description: "Full AI pipeline with embeddings and translation"
body:
  config:
    batch-size: 10
    execution:
      mode: sequential           # sequential|parallel
      max-concurrency: 4

  variables:
    book_name: my first book
    genres:                      # Comma-separated or list form accepted
      - game
      - fantasy

  # Exactly one of source|items required
  source:
    type: file                   # file|http|git|s3
    file-location: "./input/book.pdf"
    format: md                   # folder|md|json|jsonl|pdf|docx

  items:
    type: chapter                # chapter|paragraph|line|document|page

  # State definitions (ordered)
  states:
    - name: PREPROCESS
      tools:
        - tool: language-detector
          async: true
          output-key: detected_lang
        - tool: text-normalizer
          async: true
          output-key: normalized

    - name: SUMMARY
      condition: "{{ item.type != 'preface' }}"
      tools:
        - tool: qwen-summary
          input: "{{item.content}}"
          output-key: summary

  listeners:
    on_item_complete:
      - tool: md-formatter
    on_pipeline_complete:
      - tool: notify-webhook
```

### Tool Declaration Rules

- Shorthand: `- tool-name`
- Object form: `- tool: tool-name`
- `output-key` defaults to tool name if omitted
- Terminal `listeners` execute after the final state for each item

### Expression Variables

Predefined variables for templates:

- `item` - Current source/items element
- `text` - Content of current element
- `index` - Element index in collection
- `runId` - Active run identifier
- `state` - Current state descriptor
- `tool` - Current tool descriptor

### Validation Rules

1. **Required fields**: version, type, name, body
2. **Type validation**: pipeline|tools|root must match filename/location
3. **Schema compliance**: Follow JSON Schema for input/output validation
4. **Reference validation**: Tool names must be resolvable
5. **Expression syntax**: {{ }} templates must use valid variable names

### File Locations

| Purpose            | Location                    |
|--------------------|-----------------------------|
| Root config        | `seed.yaml` or `root.yml`   |
| Tools config       | `.mt/tools.yaml`            |
| Pipeline manifests | `src/main/manifests/*.yaml` |

## Templates

Use templates in `templates/` directory for consistent structure.

## Examples

See `examples/` directory for complete configuration examples.

## References

- `docs/tdd.md:77-445` for complete schema specification
- Existing YAML files in project for patterns
- JSON Schema validation rules for input/output schemas
