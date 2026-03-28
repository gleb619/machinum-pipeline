# Machinum Pipeline Development Instructions

## Project Overview

**Machinum Pipeline** is a pluggable document processing orchestration engine that manages stateful pipelines with tool
composition, checkpointing, and hybrid execution modes.

**Core Capabilities** (see [technical-design.md](technical-design.md#1-project-overview)):

- Process items (chapters, documents, files) through state machine–defined pipelines
- Support internal (Java) and external (Shell/Docker) tools with JSON I/O
- Provide checkpointing for resume capabilities
- Offer CLI, server, and MCP interfaces
- Include read-only admin UI for monitoring

**Technology Stack** (see [technical-design.md](technical-design.md#2-technology-stack)):

- Java 25 + Gradle 8.x, Picocli 4.7+, Jooby 4.1, SnakeYAML 2.0+, Jackson 3.1+, Groovy 4.0+, SLF4J + Logback

## TDD Development Process

This project follows a **YAML-First Test-Driven Development** approach:

### 1. Define YAML Configuration First

- Create pipeline manifests in `examples/{example-name}/src/main/manifests/*.yaml`
- Define tool configurations in `examples/{example-name}/.mt/tools.yaml`
- Specify root configuration in `examples/{example-name}/seed.yaml`
- Reference YAML schema design in [yaml-schema.md](yaml-schema.md)

### 2. Test Processing Pipeline

- Write tests that load and validate YAML configurations
- Test pipeline execution with sample data
- Verify tool integration and state transitions
- Use checkpoint/resume functionality in tests

### 3. Iterate Based on Test Results

- Refine YAML configurations based on test failures
- Enhance error handling and validation
- Add missing tool implementations
- Improve performance and reliability

### Example TDD Workflow

```bash
# 1. Create YAML configuration
mkdir -p examples/my-test/src/main/manifests examples/my-test/.mt
cat > examples/my-test/src/main/manifests/test-pipeline.yaml << EOF
version: 1.0.0
type: pipeline
name: "test-pipeline"
body:
  # ... configuration
EOF
cat > examples/my-test/src/main/manifests/seed.yaml << EOF
version: 1.0.0
type: root
name: "Test Processing Runtime Config"
body:
  # ... configuration
EOF

# 2. Run pipeline to test YAML
./gradlew run --args="run test-pipeline --dry-run --workspace $(PWD)/examples/my-test"

# 3. Fix issues based on output
# 4. Repeat until tests pass
```

## Task Continuation Prompt

### Instructions for LLM Agent

1. **READ FIRST**: Start by reading `docs/tdd.md` to understand the technical architecture and design decisions.

2. **READ PLAN**: Read `docs/plan.md` (this file) to understand the overall development plan and current status.

3. **SELECT TASK**: Choose a task with status `⏳ Pending` from the unified task table. Prefer tasks on the critical
   path (Phase 0 → 1 → 2 → 5).

4. **BLOCK TASK**: Immediately update `docs/plan.md` to change the task status from `⏳ Pending` to `🔄 In Progress` to
   prevent other agents from working on the same task.

5. **WORK IN SESSIONS**:
    - Large tasks may require multiple sessions
    - At the end of each session, document progress in a temporary file
    - Use that file to resume in the next session
    - If interrupted, leave clear notes about what was in progress

6. **AFTER COMPLETION**:
    - Create a result document at `docs/results/{task-name}.result.md`
    - Use the template at `docs/result.template.md`
    - Document:
        - What was done
        - Files created/modified/deleted
        - Testing performed
        - Links to PRs or related work
        - Any follow-ups or technical debt
    - Update `docs/plan.md` to mark task as `✅ Complete`
    - Link to the result document in the plan

7. **TEMPLATE USAGE**:
    - For new detailed task descriptions, use `docs/task.template.md`
    - For result documentation, use `docs/result.template.md`

### Example Task Selection

"I'm starting Task 0.1: Add Groovy Dependency"
→ Update status in plan: `⏳ Pending` → `🔄 In Progress`
→ Read: `docs/tasks/002-external-tools-support.md`
→ Implement: Add Groovy 4.0+ to build.gradle
→ Test: Verify build compiles
→ Document: Create `docs/results/002-external-tools-support.result.md`
→ Complete: Update plan status to `✅ Complete`

### Key File References

- **Technical Design**: [technical-design.md](technical-design.md) - Complete architecture and design
- **YAML Schema**: [yaml-schema.md](yaml-schema.md) - Configuration file formats
- **Core Architecture**: [core-architecture.md](core-architecture.md) - State management, checkpointing, monitoring
- **CLI Commands**: [cli-commands.md](cli-commands.md) - Command-line interface
- **Project Structure**: [project-structure.md](project-structure.md) - Module organization