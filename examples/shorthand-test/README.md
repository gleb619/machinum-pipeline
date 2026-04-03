# Shorthand Test Example

This example demonstrates the **shorthand forms** for `tools.yaml` configuration.

## What This Tests

- Registry: `registry: classpath://default`
- Bootstrap list shorthand: `- tool-name`
- Tools list shorthand: `- tool-name`
- Mixed shorthand and object forms

## Files

| File                                                                                       | Purpose                                |
|--------------------------------------------------------------------------------------------|----------------------------------------|
| [`seed.yaml`](seed.yaml)                                                                   | Root configuration                     |
| [`.mt/tools.yaml`](.mt/tools.yaml)                                                         | Basic shorthand example (strings only) |
| [`.mt/tools-full.yaml`](.mt/tools-full.yaml)                                               | Comprehensive example (mixed forms)    |
| [`src/main/manifests/shorthand-pipeline.yaml`](src/main/manifests/shorthand-pipeline.yaml) | Test pipeline                          |

## Run This Example

```bash
# Setup workspace (bootstrap tools)
./gradlew :cli:run --args="setup -w ./examples/shorthand-test"

# Run pipeline
./gradlew :cli:run --args="run -p shorthand-pipeline -w ./examples/shorthand-test"

# Check results
ls examples/shorthand-test/build/
ls examples/shorthand-test/.mt/state/
```

## Shorthand Syntax Reference

### Registry Configuration

```yaml
# Builtin
registry: classpath://default

# Http
registry: https://example.com/tools.yaml
```

### Bootstrap Tools

```yaml
bootstrap:
  - tool1                    # shorthand
  - tool2                    # shorthand
  - name: tool3              # object form
    description: "Description"
    config:
      key: value
```

### Custom Tools

```yaml
tools:
  - qwen-summary             # shorthand
  - md-formatter             # shorthand
  - name: translator         # object form
    description: "Translate"
    config:
      model: gpt-4
```

## See Also

- [YAML Schema §3.0 - Shorthand Forms](../../docs/yaml-schema.md#30-shorthand-forms)
- [ToolsBody.java](../../core/src/main/java/machinum/manifest/ToolsBody.java) - Implementation
- [BootstrapToolManifestDeserializer](../../core/src/main/java/machinum/manifest/BootstrapToolManifestDeserializer.java)
- [ToolManifestDeserializer](../../core/src/main/java/machinum/manifest/ToolManifestDeserializer.java)
- [ToolRegistryConfigManifestDeserializer](../../core/src/main/java/machinum/manifest/ToolRegistryConfigManifestDeserializer.java)
