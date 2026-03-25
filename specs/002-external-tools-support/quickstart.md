# Quickstart: External Tools & Workspace Management

## Prerequisites
- Phase 1 MVP foundation complete (`001-phase1-mvp-foundation`)
- Java 25 runtime available
- Gradle 9.4.1+ available
- Groovy 4.0+ available (added by this feature)

---

## Workspace Initialization

### Initialize New Workspace
```bash
# Create workspace from scratch
machinum install

# Or specify workspace directory
machinum install --workspace /path/to/workspace
```

**Expected output:**
```
[INFO] Downloading tool sources...
[INFO] Bootstrapping workspace...
[INFO] Created directory: .mt/
[INFO] Created directory: src/main/chapters/
[INFO] Created directory: src/main/manifests/
[INFO] Created directory: build/
[INFO] Generated: seed.yaml
[INFO] Generated: .mt/tools.yaml
[INFO] Workspace initialization complete!
```

### Download Only (No Workspace Mutation)
```bash
# Fetch tool sources without creating workspace structure
machinum install download
```

### Force Overwrite Existing Files
```bash
# Overwrite existing configuration files
machinum install bootstrap --force
```

---

## External Shell Tool Example

### 1. Create Shell Script
Create `.mt/scripts/transformers/uppercase.sh`:
```bash
#!/usr/bin/env bash
# Read JSON from stdin, transform, write to stdout
jq '.text |= ascii_upcase'
```

Make it executable:
```bash
chmod +x .mt/scripts/transformers/uppercase.sh
```

### 2. Add Tool to tools.yaml
Edit `.mt/tools.yaml`:
```yaml
body:
  tools:
    - name: uppercase-transformer
      type: external
      runtime: shell
      source:
        type: file
        url: ".mt/scripts/transformers/uppercase.sh"
      timeout: 30s
      config:
        work-dir: "{{rootDir}}"
```

### 3. Use in Pipeline
Create `src/main/manifests/test-pipeline.yaml`:
```yaml
version: 1.0.0
type: pipeline
name: "test-external-tools"
body:
  source:
    type: file
    file-location: "./src/main/chapters/input.md"
    format: md
  
  states:
    - name: TRANSFORM
      tools:
        - tool: uppercase-transformer
          input: "{{item.content}}"
          output-key: transformed_text
    
    - name: FINISHED
      tools:
        - tool: peek
          input: "{{transformed_text}}"
```

### 4. Execute Pipeline
```bash
machinum run test-external-tools
```

**Expected logs:**
```
[INFO] Run started: run-20260325-abc123
[INFO] Item: chapter-001, State: TRANSFORM, Tool: uppercase-transformer, Duration: 45ms
[INFO] Item: chapter-001, State: FINISHED, Tool: peek, Duration: 2ms
[INFO] Run completed successfully
```

---

## External Groovy Tool Example

### 1. Create Condition Script
Create `.mt/scripts/conditions/should_clean.groovy`:
```groovy
// Return true if text needs cleaning
return text.contains('<html>') || text.contains('&nbsp;')
```

### 2. Add Tool to tools.yaml
```yaml
body:
  tools:
    - name: html-cleaner
      type: external
      runtime: groovy
      source:
        type: file
        url: ".mt/scripts/transformers/clean_html.groovy"
      timeout: 30s
```

### 3. Use Condition in Pipeline
```yaml
states:
  - name: CLEAN_HTML
    condition: "{{scripts.conditions.should_clean(item)}}"
    tools:
      - tool: html-cleaner
        input: "{{item.content}}"
        output-key: cleaned_text
```

---

## Expression Resolution Examples

### Environment Variables
```yaml
tools:
  - name: api-client
    config:
      api-key: "{{env.OPENAI_API_KEY}}"
      endpoint: "{{env.API_ENDPOINT}}"
```

### Predefined Variables
```yaml
states:
  - name: LOG_STATS
    tools:
      - tool: logger
        config:
          message: "Processing item {{index}} with {{textLength}} chars"
          run-id: "{{runId}}"
```

### Script-Based Conditions
```yaml
states:
  - name: VALIDATE
    condition: "{{scripts.validators.is_valid_json(item)}}"
    tools:
      - tool: json-validator
```

### Method Chaining
```yaml
states:
  - name: TRUNCATE
    tools:
      - tool: text-processor
        input: "{{text.substring(0, 500)}}"
```

---

## Cleanup Command Examples

### Clean Specific Run
```bash
# Remove state for a specific run-id
machinum cleanup --run-id 20260325-abc123
```

### Clean Old Runs
```bash
# Remove runs older than 7 days
machinum cleanup --older-than 7d

# Remove runs older than 24 hours
machinum cleanup --older-than 24h
```

### Preview Cleanup
```bash
# See what would be cleaned without deleting
machinum cleanup --older-than 7d --dry-run
```

**Expected output:**
```
[INFO] Dry run mode - no files will be deleted
[INFO] Would clean 3 runs:
  - run-20260318-xyz789 (status: success, age: 8d)
  - run-20260317-def456 (status: failed, age: 9d)
  - run-20260316-ghi123 (status: success, age: 10d)
[INFO] Total: 3 runs, 15MB
```

### Force Clean Active Run
```bash
# Clean a running pipeline (use with caution)
machinum cleanup --run-id 20260325-abc123 --force
```

---

## Verification Outcomes

### Workspace Init
- [ ] `machinum install` creates `.mt/`, `src/main/`, `build/` directories
- [ ] `seed.yaml` and `.mt/tools.yaml` are generated with valid YAML
- [ ] `package.json` generated when node tools present
- [ ] Idempotent: second run skips existing files

### External Tools
- [ ] Shell scripts execute and return valid JSON
- [ ] Groovy scripts execute with correct variable binding
- [ ] Timeout enforced for long-running scripts
- [ ] Exit codes handled correctly (0 = success, non-zero = failure)

### Expression Resolution
- [ ] Environment variables resolve: `{{env.API_KEY}}`
- [ ] Predefined variables resolve: `{{text}}`, `{{runId}}`
- [ ] Script conditions execute: `{{scripts.conditions.should_clean(item)}}`
- [ ] Method chaining works: `{{text.substring(0, 100)}}`

### Cleanup
- [ ] `--run-id` removes specific run state
- [ ] `--older-than` removes runs by age
- [ ] Active runs protected without `--force`
- [ ] Dry run shows what would be deleted

---

## Troubleshooting

### Shell Script Not Executable
**Error**: `Permission denied`
**Solution**: `chmod +x .mt/scripts/transformers/your-script.sh`

### Groovy Script Not Found
**Error**: `Script file does not exist: .mt/scripts/conditions/should_clean.groovy`
**Solution**: Verify script path is correct relative to workspace root

### Expression Timeout
**Error**: `Expression resolution timed out after 5s`
**Solution**: Simplify expression or increase timeout in config

### Cleanup Fails on Active Run
**Error**: `Cannot clean active run. Use --force to override.`
**Solution**: Stop the running pipeline first, or use `--force` flag

### Package.json Not Generated
**Issue**: Node tools declared but no `package.json`
**Solution**: Ensure tools are in `install.tools` section with `phase: bootstrap_optional`

---

## Next Steps

After completing this quickstart:
1. Review `specs/002-external-tools-support/spec.md` for full requirements
2. Check `specs/002-external-tools-support/data-model.md` for entity details
3. See `specs/002-external-tools-support/tasks.md` for implementation breakdown
4. Explore example scripts in `.mt/scripts/` directory
