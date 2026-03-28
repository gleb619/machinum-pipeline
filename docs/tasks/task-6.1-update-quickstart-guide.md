# Task: 6.1-update-quickstart-guide

**Phase**: 6
**Priority**: P1
**Status**: `pending`
**Depends On**: All implementation tasks complete (2.3, 5.1, 5.2, 5.4, 5.5, 5.6)
**TDD Reference**: `docs/tdd.md`

---

## Description

Update the Quickstart Guide to include comprehensive examples for external tools support, workspace initialization,
expression resolution, and cleanup commands. This guide should enable new users to quickly understand and use the key
features of Machinum Pipeline.

---

## Acceptance Criteria

- [ ] `specs/002-external-tools-support/quickstart.md` created
- [ ] Example: `machinum install` usage with output
- [ ] Example: Shell tool in pipeline with complete YAML manifest
- [ ] Example: Groovy condition script with explanation
- [ ] Example: Groovy transformer script with explanation
- [ ] Example: Expression resolution in tool configs
- [ ] Example: `machinum cleanup` usage with various options
- [ ] All examples tested and working
- [ ] Clear section headings and navigation
- [ ] Troubleshooting section included

---

## Implementation Notes

### Document Structure

```markdown
# Quickstart: External Tools & Workspace Management

## Prerequisites

- Java 25+
- Gradle 8.x+
- Bash shell (for shell tools)
- Groovy 4.0+ (included via dependency)

## 1. Initialize Workspace

### Basic Installation

```bash
# Create new project directory
mkdir my-pipeline && cd my-pipeline

# Initialize workspace with default structure
machinum install

# What this creates:
# .mt/                    # Machinum configuration directory
# ├── scripts/            # Script storage
# │   ├── conditions/     # Condition scripts
# │   ├── transformers/   # Transformer scripts
# │   └── validators/     # Validator scripts
# ├── tools.yaml          # Tool definitions
# └── state/              # Run state storage
# src/main/
# ├── manifests/          # Pipeline definitions
# └── data/               # Input data files
# seed.yaml               # Initial configuration
```

### Installation Options

```bash
# Download only (don't create structure)
machinum install download

# Bootstrap only (create structure, no download)
machinum install bootstrap

# Force overwrite existing files
machinum install --force

# Specify workspace directory
machinum install --workspace /path/to/workspace
```

## 2. Create Your First Pipeline with External Tools

### Step 1: Define Tools

Create `.mt/tools.yaml`:

```yaml
version: 1.0.0
tools:
  - name: text-validator
    type: groovy
    runtime: groovy
    script: validators/validate_text.groovy
    return-type: Boolean

  - name: text-transformer
    type: groovy
    runtime: groovy
    script: transformers/normalize.groovy

  - name: markdown-formatter
    type: shell
    runtime: shell
    script: formatters/to_markdown.sh
    timeout: 30s
```

### Step 2: Create Scripts

**Validator Script** (`.mt/scripts/validators/validate_text.groovy`):

```groovy
// Validate that text is not empty
// Returns: Boolean
// Context: item (Map), text (String), env (Map)

if (text == null || text.trim().isEmpty()) {
  return false
}

// Check minimum length
return text.trim().length() >= 10
```

**Transformer Script** (`.mt/scripts/transformers/normalize.groovy`):

```groovy
// Normalize whitespace in text
// Returns: Map with transformed text
// Context: text (String)

def normalized = text.replaceAll(/\s+/, ' ').trim()

return [
    result        : normalized,
    originalLength: text.length(),
    newLength     : normalized.length(),
    compressed    : text.length() - normalized.length()
]
```

**Shell Script** (`.mt/scripts/formatters/to_markdown.sh`):

```bash
#!/bin/bash
# Convert JSON input to Markdown format
# Input: {"content": "text", "type": "chapter"}
# Output: {"markdown": "# Chapter\n\ntext", "format": "markdown"}

# Read JSON from stdin
input=$(cat)

# Extract fields
content=$(echo "$input" | jq -r '.content')
type=$(echo "$input" | jq -r '.type')

# Generate markdown
case "$type" in
  "chapter")
    markdown="# Chapter\n\n$content"
    ;;
  "section")
    markdown="## Section\n\n$content"
    ;;
  *)
    markdown="$content"
    ;;
esac

# Output as JSON
jq -n --arg md "$markdown" '{"markdown": $md, "format": "markdown"}'
```

### Step 3: Create Pipeline Manifest

Create `src/main/manifests/text-processing.yaml`:

```yaml
version: 1.0.0
type: pipeline
name: "text-processing-pipeline"
variables:
  min_length: 10
  max_length: 10000
body:
  states:
    - name: VALIDATE
      condition: "{{item.type == 'chapter' || item.type == 'section'}}"
      tools:
        - tool: text-validator
          config:
            script: validators/validate_text.groovy

    - name: TRANSFORM
      tools:
        - tool: text-transformer
          config:
            script: transformers/normalize.groovy

    - name: FORMAT
      tools:
        - tool: markdown-formatter
          config:
            script: formatters/to_markdown.sh
            env:
              FORMAT_VERSION: "1.0"
```

## 3. Use Expression Resolution

### Template Expressions

Expressions in `{{...}}` are evaluated with Groovy:

```yaml
version: 1.0.0
type: pipeline
name: "expression-example"
variables:
  book_name: "My Book"
  version: 2
body:
  states:
    - name: PROCESS
      condition: "{{item.type == 'chapter' && item.priority > 5}}"
      tools:
        - tool: dynamic-tool
          config:
            # Access item properties
            path: "output/{{item.id}}.json"

            # Use environment variables
            api_key: "{{env.API_KEY}}"

            # Use pipeline variables
            metadata:
              book: "{{variables.book_name}}"
              version: "{{variables.version}}"

            # Groovy expressions
            computed: "{{index * 2 + 1}}"
```

### Script-Based Expressions

Call scripts dynamically in expressions:

```yaml
condition: "{{scripts.conditions.is_valid(item)}}"
```

Create `.mt/scripts/conditions/is_valid.groovy`:

```groovy
// Called via: {{scripts.conditions.is_valid(item)}}
// Arguments: item (passed as 'arg' or first positional)

def requiredFields = ['id', 'type', 'content']
def missing = requiredFields.findAll {!item.containsKey(it)}

if (missing) {
  println "Missing fields: ${missing.join(', ')}"
  return false
}

return item.content != null && !item.content.isEmpty()
```

## 4. Execute Pipeline

### Basic Execution

```bash
# Run pipeline
machinum run --pipeline text-processing

# Run with specific data file
machinum run --pipeline text-processing --data src/main/data/chapters.json

# Run with custom run ID
machinum run --pipeline text-processing --run-id my-run-001

# Run with environment variables
machinum run --pipeline text-processing --env API_KEY=secret123
```

### Resume After Failure

```bash
# Resume from last checkpoint
machinum resume --run-id my-run-001

# Resume from specific state
machinum resume --run-id my-run-001 --from-state TRANSFORM
```

## 5. Cleanup Run History

### Age-Based Cleanup

```bash
# Remove runs older than 7 days
machinum cleanup --older-than 7d

# Remove runs older than 24 hours
machinum cleanup --older-than 24h

# Remove runs older than 1 week
machinum cleanup --older-than 1w
```

### Specific Run Cleanup

```bash
# Remove specific run
machinum cleanup --run-id my-run-001
```

### Policy-Based Cleanup

```bash
# Use retention policy from root config
machinum cleanup

# Preview what would be cleaned (dry run)
machinum cleanup --dry-run

# Force cleanup including active runs
machinum cleanup --force
```

### Retention Policy Configuration

Create `root.yaml`:

```yaml
version: 1.0.0
cleanup:
  # Time-based retention
  successRetention: 5d      # Keep successful runs for 5 days
  failedRetention: 10d      # Keep failed runs for 10 days

  # Count-based retention
  maxSuccessfulRuns: 20     # Keep max 20 successful runs
  maxFailedRuns: 50         # Keep max 50 failed runs
```

## 6. Troubleshooting

### Common Issues

**Issue: Script not found**

```
ERROR: Shell script does not exist: /path/to/script.sh
```

**Solution**: Verify script path in tools.yaml and ensure script exists.

**Issue: Permission denied**

```
ERROR: Shell script is not readable: /path/to/script.sh
```

**Solution**: Make script executable: `chmod +x script.sh`

**Issue: Expression resolution failed**

```
ERROR: Expression resolution failed for: {{item.missing_field}}
```

**Solution**: Check that the field exists or use null-safe operator: `{{item?.missing_field}}`

**Issue: Timeout**

```
ERROR: Shell script timed out after 30s
```

**Solution**: Increase timeout in tool config:

```yaml
tools:
  - name: slow-tool
    timeout: 60s  # Increase timeout
```

### Debug Mode

Enable verbose logging:

```bash
machinum run --pipeline my-pipeline --log-level DEBUG
```

Check logs:

```bash
# View latest run log
tail -f .mt/logs/latest.log

# View specific run log
cat .mt/logs/run-001.log
```

## Next Steps

- Read full documentation: `docs/tdd.md`
- See example pipelines: `examples/`
- Learn about all CLI commands: `machinum help`

```

---

## Resources

**Files to Create**:
- `specs/002-external-tools-support/quickstart.md`

**Files to Read**:
- `README.md` - Existing quickstart
- `docs/tdd.md` - Technical design
- `specs/002-external-tools-support/spec.md` - Feature specification

---

## Plan

1. **Create quickstart document** with all sections
2. **Add workspace init examples** with output
3. **Add shell tool example** with complete YAML
4. **Add Groovy script examples** (condition, transformer, validator)
5. **Add expression resolution examples**
6. **Add cleanup command examples**
7. **Add troubleshooting section**
8. **Test all examples** to ensure they work
9. **Review and refine** for clarity

---

## Result

Link to: `docs/results/6.1-update-quickstart-guide.result.md`
