# Empty Body Test Examples

This folder contains examples demonstrating manifest bodies with empty/missing/optional fields.

## Examples Overview

### Example 1: Completely Empty Bodies
Files:
- `seed-empty.yaml` - Root with no body field
- `.mt/tools-empty.yaml` - Tools with no body field  
- `src/main/manifests/empty-pipeline.yaml` - Pipeline with no body field

**Purpose:** Test that compilers handle completely missing `body` sections gracefully.

### Example 2: Semi-Empty Bodies
Files:
- `seed-partial.yaml` - Root with only variables
- `.mt/tools-partial.yaml` - Tools with only bootstrap list
- `src/main/manifests/partial-pipeline.yaml` - Pipeline with only source

**Purpose:** Test that compilers apply defaults for missing optional sections.

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
./gradlew :cli:run --args="setup -w /home/boris/WORKSPACE/machinum-pipeline/examples/empty-body-test"

# Test with specific pipeline configuration
./gradlew :cli:run --args="run -p minimal-pipeline -w /home/boris/WORKSPACE/machinum-pipeline/examples/empty-body-test"
```

**Note:** Use absolute paths for the `-w` workspace argument to avoid path resolution issues.

## Default Values Applied

### Root Body Defaults
- `variables`: empty map
- `execution`: null (uses runtime defaults)
- `config`: null (uses runtime defaults)
- `errorHandling`: null (uses runtime defaults)
- `cleanup`: null (uses runtime defaults)
- `envFiles`: empty list
- `env`: empty map

### Tools Body Defaults
- `registry`: null (uses builtin)
- `bootstrap`: empty list
- `tools`: empty list

### Pipeline Body Defaults
- `config`: null (uses runtime defaults)
- `variables`: empty map
- `source`: null (must be provided for execution)
- `items`: null (must be provided for execution)
- `states`: empty list
- `listeners`: empty map
- `errorHandling`: null (uses runtime defaults)

## Documentation Links
- [YAML Schema - Root](../../../docs/yaml-schema.md#2-root-pipeline-yaml)
- [YAML Schema - Tools](../../../docs/yaml-schema.md#3-tools-yaml)
- [YAML Schema - Pipeline](../../../docs/yaml-schema.md#4-pipeline-declaration-yaml)
- [Technical Design - Value Compilation](../../../docs/technical-design.md#33-value-compilation-system)
- [CLI Commands - Setup](../../../docs/cli-commands.md#setup)
