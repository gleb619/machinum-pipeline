# Sample YAML Configurations

## Root Configuration Example

```yaml
# seed.yaml - Root runtime configuration
version: 1.0.0
type: root
name: "Document Processing Runtime"
description: "Configuration for document processing pipeline"
metadata:
  author: "Machinum Team"
  created: "2026-03-25"
body:
  metadata:
    project_id: doc_processor_001
  execution:
    parallel: false
    max-concurrency: 2
    resume: true
    manifest-snapshot:
      enabled: true
      mode: copy
  error-handling:
    retry:
      max-attempts: 3
      backoff:
        type: exponential
        initial-delay: 1s
        max-delay: 30s
        multiplier: 2.0
        jitter: 0.1
    strategies:
      - exception: "TimeoutException"
        strategy: retry
      - exception: "ValidationException"
        strategy: skip
      - exception: ".*"
        strategy: stop
  cleanup:
    success: 7d
    failed: 14d
    success-runs: 10
    failed-runs: 5
  env-files:
    - ".env"
    - ".ENV.local"
  env:
    LOG_LEVEL: INFO
    CACHE_DIR: "{{rootDir}}/.cache"
```

## Tools Configuration Example

```yaml
# .mt/tools.yaml - Tool definitions
version: 1.0.0
type: tools
name: "Document Processing Tools"
description: "Tools for document processing pipeline"
metadata:
  created: "2026-03-25"
body:
  tools:
    - name: text-extractor
      config:
        max_file_size: 50MB
        supported_formats: [pdf, docx, txt]

    - name: ai-summarizer
      config:
        model: qwen2.5-72b
        temperature: 0.3
        max_tokens: 1000
        runtime: shell
        source:
          type: http
          url: "https://raw.githubusercontent.com/company/summarizer/main/summarize.py"
        args:
          - "--model"
          - "qwen2.5-72b"
          - "--input"
          - "{{input.content}}"
        timeout: 120s
        cache:
          enabled: true
          key: "summarize:{{model}}:{{sha256(input.content)}}"
          ttl: 24h

    - name: language-detector
      # Minimal SPI declaration
      config:
        confidence_threshold: 0.8

    - name: document-converter
      config:
        output_format: markdown
        preserve_formatting: true
        source:
          type: docker
          image: "document-converter:latest"
```

## Pipeline Configuration Example

```yaml
# src/main/manifests/document-processing.yaml
version: 1.0.0
type: pipeline
name: "document-processing"
description: "Process documents through extraction, summarization, and analysis"
body:
  config:
    batch-size: 5
    window-batch-size: 3
    cooldown: 2s
    execution:
      mode: sequential
      max-concurrency: 2

  variables: {}

  source:
    type: file
    file-location: "./input/documents/"
    format: pdf
    metadata:
      source_system: "document_management"

  items:
    type: document
    custom-extractor: "{{scripts/extractors/document-extractor.groovy}}"

  states:
    - name: EXTRACT
      tools:
        - tool: text-extractor
          output: extracted_text
        - tool: language-detector
          input: "{{extracted_text}}"
          output: detected_language
          async: true

    - name: SUMMARIZE
      condition: "{{detected_language.confidence > 0.8}}"
      tools:
        - tool: ai-summarizer
          input:
            content: "{{extracted_text}}"
            language: "{{detected_language.language}}"
          output: summary

    - name: ANALYZE
      tools:
        - tool: document-analyzer
          input:
            text: "{{extracted_text}}"
            summary: "{{summary}}"
          output: analysis

  listeners:
    on_item_complete:
      - tool: markdown-formatter
        input:
          content: "{{summary}}"
          analysis: "{{analysis}}"
          output: formatted_output
      - tool: metrics-collector
        async: true

    on_pipeline_complete:
      - tool: notification-sender
        input:
          message: "Document processing completed"
          count: "{{items.length}}"

  error-handling:
    default-strategy: retry
    retry-config:
      max-attempts: 2
      backoff: fixed
    strategies:
      - exception: "FileSizeExceededException"
        strategy: skip
      - exception: "UnsupportedFormatException"
        strategy: stop
```
