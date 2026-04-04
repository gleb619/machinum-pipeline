# Empty Body Test Examples

This folder contains examples demonstrating manifest bodies with empty/missing/optional fields.

## Examples Overview

### Example 2: Semi-Empty Bodies
Files:
- `seed-partial.yaml` - Root with only variables
- `.mt/tools-partial.yaml` - Tools with only bootstrap list
- `src/main/manifests/partial-pipeline.yaml` - Pipeline with only source

**Purpose:** Test that compilers apply defaults for missing optional sections.

## Running Tests

```bash
# Navigate to project root
cd /path/to/machinum-pipeline

# Test empty body handling (use absolute path)
./gradlew :cli:run --args="setup -w ./examples/empty-body-test/minimal"

# Test with specific pipeline configuration
./gradlew :cli:run --args="run -p minimal-pipeline -w ./examples/empty-body-test/minimal"
```

**Note:** Use absolute paths for the `-w` workspace argument to avoid path resolution issues.

## Documentation Links
- [YAML Schema - Root](../../../docs/yaml-schema.md#2-root-pipeline-yaml)
- [YAML Schema - Tools](../../../docs/yaml-schema.md#3-tools-yaml)
- [YAML Schema - Pipeline](../../../docs/yaml-schema.md#4-pipeline-declaration-yaml)
- [Technical Design - Value Compilation](../../../docs/technical-design.md#33-value-compilation-system)
- [CLI Commands - Setup](../../../docs/cli-commands.md#setup)
