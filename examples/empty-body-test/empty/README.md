# Empty Body Test Examples

This folder contains examples demonstrating manifest bodies with empty/missing/optional fields.

## Examples Overview

### Example 1: Completely Empty Bodies
Files:
- `seed-empty.yaml` - Root with no body field
- `.mt/tools-empty.yaml` - Tools with no body field  
- `src/main/manifests/empty-pipeline.yaml` - Pipeline with no body field

**Purpose:** Test that compilers handle completely missing `body` sections gracefully.

## Running Tests

```bash
# Navigate to project root
cd /path/to/machinum-pipeline

# Test empty body handling (use absolute path)
./gradlew :cli:run --args="setup -w ./examples/empty-body-test/empty"

# Test with specific pipeline configuration
./gradlew :cli:run --args="run -p minimal-pipeline -w ./examples/empty-body-testempty"
```

**Note:** Use absolute paths for the `-w` workspace argument to avoid path resolution issues.

## Documentation Links
- [YAML Schema - Root](../../../docs/yaml-schema.md#2-root-pipeline-yaml)
- [YAML Schema - Tools](../../../docs/yaml-schema.md#3-tools-yaml)
- [YAML Schema - Pipeline](../../../docs/yaml-schema.md#4-pipeline-declaration-yaml)
- [Technical Design - Value Compilation](../../../docs/technical-design.md#33-value-compilation-system)
- [CLI Commands - Setup](../../../docs/cli-commands.md#setup)
