---
name: yaml-config
description: Work with YAML configuration files for Machinum Pipeline including pipelines, tools, and root configs. Use when creating, modifying, or validating YAML files.
---

## Overview

Machinum Pipeline uses YAML manifests to configure tools, pipelines, and runtime behavior.
All files share a common base; `body` is always optional (defaults to empty/safe values).

---

## Common Base Structure

```yaml
version: 1.0.0
type: pipeline|tools|root|manifest
name: string
description: string          # optional
labels:
  key: value
metadata:
  author: string
  created: timestamp
body: {}                     # type-specific; omit = safe defaults applied
```

---

## File Types & Locations

| File                               | Type       | Purpose                   |
|------------------------------------|------------|---------------------------|
| `seed.yaml`                        | `root`     | Global runtime config     |
| `.mt/tools.yaml`                   | `tools`    | Tool registry & bootstrap |
| `src/main/manifests/pipeline.yaml` | `pipeline` | Pipeline definition       |

Missing files → `Executor.setDefaults()` applies empty safe defaults automatically.

---

## root (seed.yaml)

```yaml
version: 1.0.0
type: root
name: "My Runtime"
body:
  variables:
    book_id: my_book_123
  execution:
    parallel: false
    concurrency: 4
    resume: true
    snapshot:
      mode: copy              # copy|reference
  fallback:
    retry:
      max: 3
      backoff:
        type: fixed           # fixed|linear|exponential
        start: 1s
        max: 30s
        multiplier: 2.0
        jitter: 0.15
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: "ValidationException"
        strategy: skip
      - exception: ".*"
        strategy: stop
  config:
    batch: 10
    window: 5
    cooldown: 5s
    override: false
    async: false
  cleanup:
    pass: 5d
    fail: 7d
    passes: 5
    fails: 10
  secrets:
    - ".env"
  env:
    API_KEY: "{{env.OPENAI_KEY}}"
```

---

## tools (.mt/tools.yaml)

```yaml
version: 1.0.0
type: tools
name: "Default Toolset"
body:
  registry: classpath://default   # builtin|file://|http://|classpath://
  bootstrap:
    - prettier                    # shorthand
    - git                         # shorthand
    - name: eslint                # object form
      description: "Linting"
      config:
        config-file: ".eslintrc"
  tools:                          # tools[] does NOT support shorthand
    - name: qwen-summary
      description: "Summarization"
      config:
        model: qwen2.5-72b
        temperature: 0.7
    - name: text-validator
      extends: groovy
      config:
        script: "./.mt/scripts/validate.groovy"
```

**Shorthand only in `bootstrap[]`:**  
`- tool-name` → same as `- name: tool-name`

---

## pipeline (src/main/manifests/pipeline.yaml)

Exactly one of `source` **or** `items` required for execution.

```yaml
version: 1.0.0
type: pipeline
name: "my-pipeline"
body:
  config:
    batch: 10
    window: 5
    cooldown: 5s
    override: false
    snapshot: reference           # copy|reference
    runner: one_step              # one_step|batch_step|batch_step_over

  variables:
    book_name: my first book
    genres:
      - fantasy
    tags:
      - cunning protagonist

  # --- Data acquisition (pick one `source` or `items`) ---
  source:
    uri: "file://src/main/chapters?format=md"

  items:
    type: chapter                 # chapter|paragraph|line|document|page
    file-location: "src/main/chapters"

  # --- States ---
  states:
    - name: PREPROCESS
      tools:
        - tool: language-detector
          async: true
          output: detected_lang
        - tool: text-normalizer
          input: "{{text}}"
          output: normalized_text

    - name: SUMMARY
      condition: "{{ item.type != 'preface' }}"
      tools:
        - tool: qwen-summary
          input: "{{item.content}}"
          output: summary

    - name: CLEANING
      condition: "{{ scripts.conditions.should_clean(item) }}"
      tools:
        - text-cleaner              # shorthand

    - name: FORK_PROCESSING
      fork:
        branches:
          - name: embedding-branch
            states:
              - name: EMBED
                tools:
                  - tool: embedding-generator
                    output: embedding
          - name: glossary-branch
            states:
              - name: EXTRACT_GLOSSARY
                tools:
                  - glossary-extractor

    - name: TRANSLATE_TITLE
      window:
        type: tumbling
        size: "{{config.batch}}"
        aggregation:
          group-by: title
          tools:
            - batch-translator
          output: translated_titles

    - name: TRANSLATE
      tools:
        - tool: peek
          tools:                    # tool chain; output = last tool's result
            - tool: language-detector
            - tool: translator
              input:
                text: "{{cleaned_text}}"
                glossary: "{{final_glossary}}"
          output: translated_text

    - name: FINISHED
      wait-for: "{{config.cooldown}}"

  # Stateless tools (no states needed) - not compatible with states, choose only one
  tools:
    - mock-processor
    - tool: text-cleaner

  interceptors:
    - validation-interceptor        # shorthand
    - tool: metrics-interceptor

  listeners:
    after:
      - md-formatter
      - tool: metrics-collector
        async: true
    finish:
      - tool: notify-webhook
        input: "{{translated_text}}"
      - log-summary

  fallback:
    retry:
      max: 3
      backoff: exponential
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: ".*"
        strategy: stop
```

---

## Source URI Schemas

| Schema       | Example                                       | Notes                    |
|--------------|-----------------------------------------------|--------------------------|
| `file://`    | `file://src/main/chapters?format=md`          | Local files/dirs         |
| `http(s)://` | `https://api.example.com/items`               |                          |
| `samples://` | `samples://default`                           | Built-in test chapters   |
| `void://`    | `void://`                                     | No-op, 0 items           |
| `script://`  | `script://.mt/scripts/loader.groovy`          | Post-MVP                 |

**`format` param:** `md`, `json`, `jsonl`, `folder`, `pdf`, `docx`, `txt` (default: `folder`)

---

## Tool Declaration Rules

| Form          | Syntax                     | Notes                                          |
|---------------|----------------------------|------------------------------------------------|
| Shorthand     | `- tool-name`              | Only in `states[].tools`, `tools`, `bootstrap` |
| Object        | `- tool: tool-name`        | Use when setting input/output/async            |
| `output`      | defaults to tool name      |                                                |
| `async: true` | non-blocking execution     | Next sequential tool auto-waits                |
| `input`       | string, map, or `{{expr}}` |                                                |

---

## Expression Variables

| Variable           | Description                        |
|--------------------|------------------------------------|
| `item`             | Current pipeline item              |
| `text`             | Item content                       |
| `index`            | Item index                         |
| `textLength`       | Char count                         |
| `textWords`        | Word count                         |
| `textTokens`       | Token count (CL100K_BASE)          |
| `aggregationIndex` | Window/aggregation index           |
| `aggregationText`  | Window aggregation result          |
| `runId`            | Active run ID                      |
| `state`            | Current state descriptor           |
| `tool`             | Current tool descriptor            |
| `retryAttempt`     | Current retry number               |

---

## CLI Quick Reference

```bash
machinum setup                          # download + bootstrap
machinum setup download                 # fetch sources only
machinum setup bootstrap                # init workspace + run bootstrap()
machinum run [pipeline-name]            # execute pipeline
machinum run --resume <run-id>          # resume from checkpoint
machinum run --dry-run                  # validate only
machinum cleanup --older-than 7d
machinum status --run-id <id>
machinum serve --port 7070 --ui
```