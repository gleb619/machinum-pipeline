# Feature Specification: External Tools & Workspace Management

**Feature Branch**: `002-external-tools-support`
**Created**: 2026-03-25
**Status**: Draft
**Input**: External tools support (shell/groovy), workspace initialization with install command, cleanup command, and Groovy-based expression resolution

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Execute Pipeline with External Shell/Groovy Tools (Priority: P1)

As a pipeline developer, I want to use shell scripts and Groovy scripts as tools in my pipeline states, so that I can leverage existing scripts and customize processing logic without writing Java code.

**Why this priority**: External tool support is essential for extensibility and allows users to integrate custom processing logic without recompiling the pipeline engine. This is a core differentiator from Phase 1's internal-only tools.

**Independent Test**: Can be tested by creating a simple pipeline with a shell script tool that transforms text, executing it, and verifying the output.

**Acceptance Scenarios**:

1. **Given** a pipeline manifest with a shell script tool defined, **When** the pipeline executes, **Then** the shell script runs with the correct input and produces valid JSON output
2. **Given** a Groovy script tool for validation, **When** an item is processed, **Then** the script evaluates the condition and returns a boolean result
3. **Given** a tool with a timeout configuration, **When** the script exceeds the timeout, **Then** the tool execution is terminated and error handling is triggered

---

### User Story 2 - Initialize Workspace with Install Command (Priority: P1)

As a new user, I want to run `machinum install` to set up my workspace with default directory structure and configuration files, so that I can start defining pipelines immediately.

**Why this priority**: Workspace initialization is the first interaction users have with the system. A smooth onboarding experience is critical for adoption.

**Independent Test**: Can be tested by running `machinum install` in an empty directory and verifying that all expected directories and files are created with correct structure.

**Acceptance Scenarios**:

1. **Given** an empty directory with `seed.yaml`, **When** I run `machinum install`, **Then** `.mt/`, `src/main/`, and `build/` directories are created with proper structure
2. **Given** a `tools.yaml` with node-based tools, **When** I run `machinum install bootstrap`, **Then** a `package.json` is generated in the workspace root
3. **Given** an existing workspace, **When** I run `machinum install download`, **Then** tool sources are fetched without mutating the workspace layout

---

### User Story 3 - Cleanup Old Runs with Policy-Based Retention (Priority: P2)

As a production user, I want to clean up old run states and checkpoints automatically based on retention policies, so that my workspace doesn't accumulate unnecessary data.

**Why this priority**: Long-running production systems need automated cleanup to manage disk space. This is important but can be done after external tools and workspace init are working.

**Independent Test**: Can be tested by creating multiple runs with different ages and statuses, then running cleanup and verifying only appropriate runs are removed.

**Acceptance Scenarios**:

1. **Given** runs older than 7 days, **When** I run `machinum cleanup --older-than 7d`, **Then** those runs are removed from the state directory
2. **Given** a specific run-id, **When** I run `machinum cleanup --run-id <id>`, **Then** only that run's state is cleaned up
3. **Given** a root config with `cleanup.success-runs: 5`, **When** cleanup runs, **Then** only the 5 most recent successful runs are retained

---

### User Story 4 - Use Expressions with Groovy Engine (Priority: P2)

As a pipeline configurator, I want to use Groovy-based expressions in my pipeline YAML to reference variables, environment values, and script results, so that my configurations are dynamic and context-aware.

**Why this priority**: Expression resolution enables dynamic behavior and is required for advanced pipeline features like conditional execution and script-based conditions.

**Independent Test**: Can be tested by creating a pipeline with expressions like `{{env.API_KEY}}` and `{{scripts.conditions.should_clean(item)}}` and verifying they resolve correctly.

**Acceptance Scenarios**:

1. **Given** an environment variable `API_KEY`, **When** I use `{{env.API_KEY}}` in a tool config, **Then** it resolves to the environment value
2. **Given** a Groovy condition script, **When** I use `{{scripts.conditions.should_clean(item)}}`, **Then** the script executes and returns a boolean
3. **Given** predefined variables like `text`, `index`, `runId`, **When** used in expressions, **Then** they resolve to current context values

---

### Edge Cases

- What happens when a shell script returns non-zero exit code? → Tool execution fails and error handling strategy is applied
- How does system handle missing script files? → Validation fails at pipeline load time with clear error message
- What happens when expression resolution fails? → Pipeline execution stops with descriptive error including the failed expression
- How are script timeouts enforced? → Process is forcibly terminated after timeout duration
- What if workspace already exists during install? → Bootstrap skips existing directories or overwrites based on flag

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST execute shell scripts as external tools with configurable timeout and retry policy
- **FR-002**: System MUST execute Groovy scripts for conditions, transformers, and validators
- **FR-003**: System MUST support script path expressions like `"{{scripts/conditions/should_clean.groovy}}"`
- **FR-004**: System MUST create default workspace structure via `machinum install bootstrap`
- **FR-005**: System MUST generate `package.json` when node tools are declared in `tools.yaml`
- **FR-006**: System MUST support `machinum cleanup --run-id` for specific run cleanup
- **FR-007**: System MUST support `machinum cleanup --older-than <duration>` for age-based cleanup
- **FR-008**: System MUST resolve environment variables in expressions: `{{env.VARIABLE_NAME}}`
- **FR-009**: System MUST provide predefined expression variables: `item`, `text`, `index`, `textLength`, `textWords`, `textTokens`, `runId`, `state`, `tool`, `retryAttempt`
- **FR-010**: System MUST execute Groovy scripts for dynamic conditions: `{{scripts.conditions.should_clean(item)}}`
- **FR-011**: External tools MUST integrate with existing error handling and retry strategies
- **FR-012**: `machinum install download` MUST fetch tool sources without mutating workspace layout
- **FR-013**: Cleanup MUST respect retention policies from root config (`success`, `failed`, `success-runs`, `failed-runs`)

### Key Entities *(include if feature involves data)*

- **ShellTool**: External tool that executes shell scripts via ProcessBuilder with timeout, retry, and environment configuration
- **GroovyScriptTool**: External tool that executes Groovy scripts via GroovyShell with binding for context variables
- **WorkspaceLayout**: Directory structure definition including `.mt/`, `src/main/`, `build/` subdirectories
- **ExpressionContext**: Runtime context containing variables, environment, item state, and script references for expression resolution
- **CleanupPolicy**: Retention configuration specifying how long to keep successful/failed runs and how many to retain

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Shell scripts execute successfully with input/output JSON matching the internal tool contract
- **SC-002**: Groovy scripts execute for conditions and return expected boolean values in 100% of test cases
- **SC-003**: `machinum install` creates complete workspace structure in under 5 seconds for default configuration
- **SC-004**: Cleanup command removes runs matching policy criteria with 100% accuracy
- **SC-005**: Expression resolution completes in under 10ms per expression for simple variable lookups
- **SC-006**: All predefined expression variables resolve correctly in integration tests
- **SC-007**: External tools honor timeout configuration in 100% of test scenarios
- **SC-008**: Integration tests cover all four user stories with passing status
