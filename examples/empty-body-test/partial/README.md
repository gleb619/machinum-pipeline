# Empty Body Test Examples

This folder contains examples demonstrating manifest bodies with empty/missing/optional fields.

## Examples Overview

### Example 3: Minimal Bodies
Files:
- `seed-minimal.yaml` - Root with empty body `{}`
- `.mt/tools-minimal.yaml` - Tools with minimal tool definition
- `src/main/manifests/minimal-pipeline.yaml` - Pipeline with source + minimal state

**Purpose:** Test that compilers handle empty body objects and minimal field sets.

## Running Tests

```bash
# Navigate to project root
cd /path/to/machinum-pipeline

# Test empty body handling (use absolute path)
./gradlew :cli:run --args="setup -w ./examples/empty-body-test/partial"

# Test with specific pipeline configuration
./gradlew :cli:run --args="run -p minimal-pipeline -w ./examples/empty-body-test/partial"
```

**Note:** Use absolute paths for the `-w` workspace argument to avoid path resolution issues.

## Documentation Links
- [YAML Schema - Root](../../../docs/yaml-schema.md#2-root-pipeline-yaml)
- [YAML Schema - Tools](../../../docs/yaml-schema.md#3-tools-yaml)
- [YAML Schema - Pipeline](../../../docs/yaml-schema.md#4-pipeline-declaration-yaml)
- [Technical Design - Value Compilation](../../../docs/technical-design.md#33-value-compilation-system)
- [CLI Commands - Setup](../../../docs/cli-commands.md#setup)
