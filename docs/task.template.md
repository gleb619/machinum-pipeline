# Task: {task-name}

**Phase**: {phase-number}  
**Priority**: P0 | P1 | P2  
**Status**: `pending` | `in_progress` | `completed`  
**Depends On**: {task-ids or "None"}
**TDD Reference**: `docs/tdd.md`

---

## Description

{Detailed description of what needs to be implemented}

---

## Acceptance Criteria

- [ ] {Criterion 1}
- [ ] {Criterion 2}
- [ ] {Criterion 3}

---

## Implementation Notes

{Technical details, implementation hints, code structure}

```java
// Example code snippet if applicable
```

---

## Resources

**Key Documentation**:
- **Technical Design**: `docs/tdd.md` (lines 1-1007) - Complete architecture and design
- **YAML Schema**: `docs/tdd.md` (lines 77-445) - Configuration file formats
- **Core Interfaces**: `docs/tdd.md` (lines 521-632) - Tool and pipeline contracts
- **Directory Structure**: `docs/tdd.md` (lines 37-68) - Workspace layout
- **CLI Commands**: `docs/tdd.md` (lines 652-676) - Command-line interface
- **Project Structure**: `docs/tdd.md` (lines 891-933) - Module organization

**Task Specific**:
- **{name}**: `{file path}` (lines {line from}-{line to}) - {Description}

---

## Spec

### Contracts

{specify contracts that can be verified via clie here}

### Data Model

{specify task data models; optional}

### Checklists

{specify here cli command to check if task could be considered as completed}

### Plan

{a concise checklist (3-7 bullets) of what you will do; keep items conceptual, not implementation-level.}

### Quickstart

- {a list of files that need to read before start task execution; optional}

---

## TDD Approach

This project follows a **YAML-First Test-Driven Development** methodology:

### 1. Start with YAML Configuration
- Define the pipeline structure in YAML first
- Specify tools, states, and execution flow
- Include error handling and retry strategies
- Validate YAML schema compliance

### 2. Create Integration Tests
- Write tests that load and parse your YAML
- Test pipeline execution with sample data
- Verify state transitions and tool outputs
- Test error scenarios and recovery

### 3. Implement Supporting Code
- Create tools referenced in YAML
- Implement validation logic
- Add error handling as needed
- Refactor based on test results

### 4. Iterate and Refine
- Adjust YAML based on test failures
- Enhance error messages and validation
- Add missing functionality
- Improve performance and reliability

**Example TDD Process**:
```bash
# 1. Create YAML manifest
cat > examples/{example-name}/src/main/manifests/{feature}.yaml << EOF
version: 1.0.0
type: pipeline
name: "feature-pipeline"
body:
  states:
    - name: PROCESS
      tools:
        - tool: my-new-tool
EOF

# 2. Write failing test
./gradlew test --tests "*FeaturePipelineTest"

# 3. Implement minimal code to pass test
# 4. Refactor and enhance
# 5. Repeat for next feature
```

---

## Result

Link to: `docs/results/{task-name}.result.md`
