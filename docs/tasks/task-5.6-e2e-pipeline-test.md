# Task: 5.6-e2e-pipeline-test

**Phase**: 5
**Priority**: P0
**Status**: `pending`
**Depends On**: All previous implementation tasks (2.3, 5.1, 5.2, 5.4, 5.5)
**TDD Reference**: `docs/tdd.md` section 3 (User Stories)

---

## Description

Create a comprehensive end-to-end integration test that exercises the full Machinum Pipeline with external tools (
ShellTool, GroovyScriptTool), expression resolution, workspace initialization, checkpoint/resume, and structured
logging. This test validates all user stories from the specification.

---

## Acceptance Criteria

- [ ] Test initializes workspace via `machinum install`
- [ ] Test creates pipeline manifest with shell and Groovy tools
- [ ] Test creates example scripts (conditions, transformers, validators)
- [ ] Test executes pipeline end-to-end successfully
- [ ] Test verifies checkpoint created and persisted
- [ ] Test verifies structured logs with correlation IDs
- [ ] Test verifies expression resolution in tool configs
- [ ] Test verifies script-based expressions work
- [ ] Test verifies environment variable injection
- [ ] Test verifies resume from checkpoint after failure
- [ ] Test verifies cleanup command works after pipeline execution
- [ ] All user stories from `specs/002-external-tools-support/spec.md` validated

---

## Implementation Notes

### Test Structure

This is a comprehensive integration test that should:

1. Initialize a workspace
2. Create pipeline manifest with external tools
3. Create scripts for conditions/transformers/validators
4. Execute pipeline
5. Verify results
6. Test resume functionality
7. Test cleanup

### Test Class Structure

```java
package machinum.integration;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.FileCheckpointStore;
import machinum.expression.ExpressionContext;
import machinum.expression.DefaultExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.PipelineStateMachine;
import machinum.manifest.PipelineManifest;
import machinum.manifest.YamlManifestLoader;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

class EndToEndPipelineTest {

  @TempDir
  Path tempDir;

  private Path workspaceRoot;
  private CommandLine cli;

  @BeforeEach
  void setUp() {
    workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectories(workspaceRoot);
    cli = new CommandLine(new machinum.cli.MachinumCli());
  }

  @Test
  void testFullPipelineExecution() throws Exception {
    // ===== PHASE 1: Initialize Workspace =====
    int installExitCode = cli.execute("install",
        "--workspace", workspaceRoot.toString());
    assertEquals(0, installExitCode, "Workspace initialization should succeed");

    // Verify workspace structure
    assertTrue(Files.exists(workspaceRoot.resolve(".mt")));
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts")));

    // ===== PHASE 2: Create Pipeline Manifest =====
    Path manifestsDir = workspaceRoot.resolve("src/main/manifests");
    Files.createDirectories(manifestsDir);

    String pipelineYaml = """
        version: 1.0.0
        type: pipeline
        name: "e2e-test-pipeline"
        variables:
          book_name: "End-to-End Test Book"
          version: 1
        body:
          states:
            - name: VALIDATE
              condition: "{{item.type == 'chapter'}}"
              tools:
                - tool: groovy-validator
                  config:
                    url: ".mt/scripts/validators/has_content.groovy"
        
            - name: TRANSFORM
              tools:
                - tool: groovy-transformer
                  config:
                    url: ".mt/scripts/transformers/uppercase.groovy"
        
                - tool: shell-formatter
                  config:
                    url: ".mt/scripts/formatters/format_output.sh"
                    env:
                      FORMAT_STYLE: "markdown"
        
            - name: AGGREGATE
              condition: "{{scripts.conditions.should_aggregate(item)}}"
              tools:
                - tool: groovy-aggregator
                  config:
                    url: ".mt/scripts/aggregators/combine_results.groovy"
        """;

    Path pipelinePath = manifestsDir.resolve("e2e-test.yaml");
    Files.writeString(pipelinePath, pipelineYaml);

    // ===== PHASE 3: Create Scripts =====
    Path scriptsDir = workspaceRoot.resolve(".mt/scripts");

    // Create validator script
    Path validatorsDir = scriptsDir.resolve("validators");
    Files.createDirectories(validatorsDir);
    Files.writeString(validatorsDir.resolve("has_content.groovy"), """
        // Validate that item has content
        return item?.containsKey('content') && item.content != null && !item.content.isEmpty()
        """);

    // Create transformer script
    Path transformersDir = scriptsDir.resolve("transformers");
    Files.createDirectories(transformersDir);
    Files.writeString(transformersDir.resolve("uppercase.groovy"), """
        // Convert text to uppercase
        return [result: text.toUpperCase(), original: text, transformed: true]
        """);

    // Create shell formatter script
    Path formattersDir = scriptsDir.resolve("formatters");
    Files.createDirectories(formattersDir);
    Path shellScriptPath = formattersDir.resolve("format_output.sh");
    Files.writeString(shellScriptPath, """
        #!/bin/bash
        # Read JSON from stdin, add formatting metadata
        input=$(cat)
        echo "$input" | jq '. + {"formatted": true, "style": (env.FORMAT_STYLE // "text")}'
        """);
    shellScriptPath.toFile().setExecutable(true);

    // Create condition script
    Path conditionsDir = scriptsDir.resolve("conditions");
    Files.createDirectories(conditionsDir);
    Files.writeString(conditionsDir.resolve("should_aggregate.groovy"), """
        // Determine if aggregation should happen
        return item?.containsKey('aggregate') && item.aggregate == true
        """);

    // Create aggregator script
    Path aggregatorsDir = scriptsDir.resolve("aggregators");
    Files.createDirectories(aggregatorsDir);
    Files.writeString(aggregatorsDir.resolve("combine_results.groovy"), """
        // Combine results
        return [
            combined: true,
            itemCount: index + 1,
            runId: runId
        ]
        """);

    // ===== PHASE 4: Create Tools Configuration =====
    Path toolsConfigPath = workspaceRoot.resolve(".mt/tools.yaml");
    String toolsYaml = """
        version: 1.0.0
        tools:
          - name: groovy-validator
            type: groovy
            runtime: groovy
            script: validators/has_content.groovy
            return-type: Boolean
        
          - name: groovy-transformer
            type: groovy
            runtime: groovy
            script: transformers/uppercase.groovy
        
          - name: shell-formatter
            type: shell
            runtime: shell
            script: formatters/format_output.sh
            timeout: 30s
        
          - name: groovy-aggregator
            type: groovy
            runtime: groovy
            script: aggregators/combine_results.groovy
        """;
    Files.writeString(toolsConfigPath, toolsYaml);

    // ===== PHASE 5: Create Test Data =====
    Path dataDir = workspaceRoot.resolve("src/main/data");
    Files.createDirectories(dataDir);

    String testData = """
        [
          {"id": "chapter-1", "type": "chapter", "content": "Hello World", "aggregate": true},
          {"id": "chapter-2", "type": "chapter", "content": "Test Content", "aggregate": false},
          {"id": "preface", "type": "preface", "content": "Preface content"}
        ]
        """;
    Files.writeString(dataDir.resolve("items.json"), testData);

    // ===== PHASE 6: Execute Pipeline =====
    String runId = "e2e-test-run-" + System.currentTimeMillis();

    int runExitCode = cli.execute("run",
        "--workspace", workspaceRoot.toString(),
        "--pipeline", "e2e-test",
        "--run-id", runId);

    // Assert pipeline execution succeeded
    assertEquals(0, runExitCode, "Pipeline execution should succeed");

    // ===== PHASE 7: Verify Checkpoint =====
    Path stateDir = workspaceRoot.resolve(".mt/state");
    assertTrue(Files.exists(stateDir), "State directory should exist");

    Path checkpointPath = stateDir.resolve(runId).resolve("checkpoint.json");
    assertTrue(Files.exists(checkpointPath), "Checkpoint file should exist");

    // Verify checkpoint content
    String checkpointContent = Files.readString(checkpointPath);
    assertTrue(checkpointContent.contains("COMPLETED"),
        "Checkpoint should show completed status");
    assertTrue(checkpointContent.contains("e2e-test-pipeline"),
        "Checkpoint should reference pipeline name");

    // ===== PHASE 8: Verify Structured Logs =====
    Path logsDir = workspaceRoot.resolve(".mt/logs");
    assertTrue(Files.exists(logsDir), "Logs directory should exist");

    Path runLogPath = logsDir.resolve(runId + ".log");
    assertTrue(Files.exists(runLogPath), "Run log should exist");

    String logContent = Files.readString(runLogPath);
    assertTrue(logContent.contains("RUNNING"), "Log should contain run state");
    assertTrue(logContent.contains("VALIDATE"), "Log should contain state transitions");
    assertTrue(logContent.contains("TRANSFORM"), "Log should contain state transitions");

    // ===== PHASE 9: Verify Expression Resolution =====
    // Check that expressions were resolved in tool execution
    assertTrue(logContent.contains("uppercase"),
        "Log should show transformer execution");
    assertTrue(logContent.contains("formatted"),
        "Log should show shell tool execution");

    // ===== PHASE 10: Verify Resume Functionality =====
    // Test that resume works (even if nothing to resume)
    int resumeExitCode = cli.execute("resume",
        "--workspace", workspaceRoot.toString(),
        "--run-id", runId);
    assertEquals(0, resumeExitCode, "Resume command should succeed");

    // ===== PHASE 11: Verify Cleanup =====
    int cleanupExitCode = cli.execute("cleanup",
        "--workspace", workspaceRoot.toString(),
        "--dry-run");
    assertEquals(0, cleanupExitCode, "Cleanup command should succeed");
  }

  @Test
  void testPipelineWithEnvironmentVariables() throws Exception {
    // Initialize workspace
    int installExitCode = cli.execute("install",
        "--workspace", workspaceRoot.toString());
    assertEquals(0, installExitCode);

    // Create pipeline that uses environment variables
    Path manifestsDir = workspaceRoot.resolve("src/main/manifests");
    Files.createDirectories(manifestsDir);

    String pipelineYaml = """
        version: 1.0.0
        type: pipeline
        name: "env-test-pipeline"
        body:
          states:
            - name: PROCESS
              tools:
                - tool: env-tester
                  config:
                    url: ".mt/scripts/use_env.groovy"
        """;

    Files.writeString(manifestsDir.resolve("env-test.yaml"), pipelineYaml);

    // Create script that uses environment variables
    Path scriptsDir = workspaceRoot.resolve(".mt/scripts");
    Files.createDirectories(scriptsDir);
    Files.writeString(scriptsDir.resolve("use_env.groovy"), """
        // Access environment variables
        def apiKey = env.get('TEST_API_KEY')
        return [apiKeySet: apiKey != null, apiKeyValue: apiKey ?: 'not set']
        """);

    // Create tools config
    String toolsYaml = """
        version: 1.0.0
        tools:
          - name: env-tester
            type: groovy
            runtime: groovy
            script: use_env.groovy
        """;
    Files.writeString(workspaceRoot.resolve(".mt/tools.yaml"), toolsYaml);

    // Execute with environment variable
    Map<String, String> env = Map.of("TEST_API_KEY", "secret-key-123");

    int runExitCode = cli.execute("run",
        "--workspace", workspaceRoot.toString(),
        "--pipeline", "env-test",
        "--env", "TEST_API_KEY=secret-key-123");

    assertEquals(0, runExitCode, "Pipeline with env vars should succeed");

    // Verify environment variable was accessible
    Path logsDir = workspaceRoot.resolve(".mt/logs");
    String logContent = Files.readString(Files.list(logsDir)
        .filter(p -> p.toString().endsWith(".log"))
        .findFirst()
        .orElseThrow());

    assertTrue(logContent.contains("secret-key-123") ||
               logContent.contains("apiKeySet: true"),
        "Log should show environment variable was accessible");
  }

  @Test
  void testPipelineWithScriptBasedExpressions() throws Exception {
    // Initialize workspace
    int installExitCode = cli.execute("install",
        "--workspace", workspaceRoot.toString());
    assertEquals(0, installExitCode);

    // Create pipeline with script-based condition
    Path manifestsDir = workspaceRoot.resolve("src/main/manifests");
    Files.createDirectories(manifestsDir);

    String pipelineYaml = """
        version: 1.0.0
        type: pipeline
        name: "script-expr-test-pipeline"
        body:
          states:
            - name: CONDITIONAL_PROCESS
              condition: "{{scripts.conditions.is_valid_type(item)}}"
              tools:
                - tool: processor
                  config:
                    url: ".mt/scripts/transformers/process.groovy"
        """;

    Files.writeString(manifestsDir.resolve("script-expr-test.yaml"), pipelineYaml);

    // Create condition script
    Path conditionsDir = workspaceRoot.resolve(".mt/scripts/conditions");
    Files.createDirectories(conditionsDir);
    Files.writeString(conditionsDir.resolve("is_valid_type.groovy"), """
        // Check if item type is valid
        def validTypes = ['chapter', 'section', 'subsection']
        return validTypes.contains(item?.type)
        """);

    // Create transformer script
    Path transformersDir = workspaceRoot.resolve(".mt/scripts/transformers");
    Files.createDirectories(transformersDir);
    Files.writeString(transformersDir.resolve("process.groovy"), """
        // Process item
        return [processed: true, type: item?.type, text: text]
        """);

    // Create tools config
    String toolsYaml = """
        version: 1.0.0
        tools:
          - name: processor
            type: groovy
            runtime: groovy
            script: transformers/process.groovy
        """;
    Files.writeString(workspaceRoot.resolve(".mt/tools.yaml"), toolsYaml);

    // Create test data
    Path dataDir = workspaceRoot.resolve("src/main/data");
    Files.createDirectories(dataDir);
    String testData = """
        [
          {"id": "1", "type": "chapter", "content": "Valid chapter"},
          {"id": "2", "type": "invalid_type", "content": "Invalid type"},
          {"id": "3", "type": "section", "content": "Valid section"}
        ]
        """;
    Files.writeString(dataDir.resolve("items.json"), testData);

    // Execute pipeline
    int runExitCode = cli.execute("run",
        "--workspace", workspaceRoot.toString(),
        "--pipeline", "script-expr-test");

    assertEquals(0, runExitCode, "Pipeline with script expressions should succeed");

    // Verify script-based condition worked
    Path logsDir = workspaceRoot.resolve(".mt/logs");
    String logContent = Files.readString(Files.list(logsDir)
        .filter(p -> p.toString().endsWith(".log"))
        .findFirst()
        .orElseThrow());

    // Should process valid types, skip invalid
    assertTrue(logContent.contains("processed: true"),
        "Log should show successful processing");
  }

  @Test
  void testPipelineFailureAndResume() throws Exception {
    // Initialize workspace
    int installExitCode = cli.execute("install",
        "--workspace", workspaceRoot.toString());
    assertEquals(0, installExitCode);

    // Create pipeline that will fail
    Path manifestsDir = workspaceRoot.resolve("src/main/manifests");
    Files.createDirectories(manifestsDir);

    String pipelineYaml = """
        version: 1.0.0
        type: pipeline
        name: "failure-test-pipeline"
        body:
          states:
            - name: FIRST_STATE
              tools:
                - tool: success-tool
                  config:
                    url: ".mt/scripts/success.groovy"
        
            - name: FAILING_STATE
              tools:
                - tool: failing-tool
                  config:
                    url: ".mt/scripts/fail.groovy"
        
            - name: FINAL_STATE
              tools:
                - tool: success-tool
                  config:
                    url: ".mt/scripts/success.groovy"
        """;

    Files.writeString(manifestsDir.resolve("failure-test.yaml"), pipelineYaml);

    // Create scripts
    Path scriptsDir = workspaceRoot.resolve(".mt/scripts");
    Files.createDirectories(scriptsDir);

    Files.writeString(scriptsDir.resolve("success.groovy"), """
        // Always succeeds
        return [status: "success"]
        """);

    Files.writeString(scriptsDir.resolve("fail.groovy"), """
        // Always fails
        throw new RuntimeException("Intentional failure for testing")
        """);

    // Create tools config
    String toolsYaml = """
        version: 1.0.0
        tools:
          - name: success-tool
            type: groovy
            runtime: groovy
            script: success.groovy
        
          - name: failing-tool
            type: groovy
            runtime: groovy
            script: fail.groovy
        """;
    Files.writeString(workspaceRoot.resolve(".mt/tools.yaml"), toolsYaml);

    // Execute pipeline (should fail)
    String runId = "failure-test-" + System.currentTimeMillis();
    int runExitCode = cli.execute("run",
        "--workspace", workspaceRoot.toString(),
        "--pipeline", "failure-test",
        "--run-id", runId);

    assertNotEquals(0, runExitCode, "Pipeline should fail");

    // Verify checkpoint created at failure point
    Path stateDir = workspaceRoot.resolve(".mt/state");
    Path checkpointPath = stateDir.resolve(runId).resolve("checkpoint.json");
    assertTrue(Files.exists(checkpointPath), "Checkpoint should exist after failure");

    String checkpointContent = Files.readString(checkpointPath);
    assertTrue(checkpointContent.contains("FAILED"),
        "Checkpoint should show failed status");
    assertTrue(checkpointContent.contains("FAILING_STATE"),
        "Checkpoint should show failure at correct state");

    // Fix the failing script
    Files.writeString(scriptsDir.resolve("fail.groovy"), """
        // Now succeeds (simulating fix)
        return [status: "recovered"]
        """);

    // Resume pipeline
    int resumeExitCode = cli.execute("resume",
        "--workspace", workspaceRoot.toString(),
        "--run-id", runId);

    // After fix, resume should succeed
    // (Note: actual behavior depends on resume implementation)
  }
}
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` section 3 - User Stories
- **Specification**: `specs/002-external-tools-support/spec.md`
- **PipelineStateMachine**: `core/src/main/java/machinum/pipeline/PipelineStateMachine.java`
- **ExpressionResolver**: `core/src/main/java/machinum/expression/DefaultExpressionResolver.java`

**Files to Create**:

- `core/src/test/java/machinum/integration/EndToEndPipelineTest.java`

**Files to Read**:

- `specs/002-external-tools-support/spec.md` - User stories
- `core/src/test/java/machinum/pipeline/SequentialRunnerTest.java` - Test style reference
- `core/src/test/java/machinum/pipeline/ResumeFlowTest.java` - Resume test reference

---

## Spec

### User Stories to Validate

**US1: External Tool Execution**

- Shell scripts execute with JSON I/O
- Groovy scripts execute with context binding
- Timeout enforcement works
- Exit codes are validated

**US2: Expression Resolution**

- Template expressions `{{...}}` resolve correctly
- Environment variables accessible via `env.VAR`
- Pipeline variables accessible
- Script-based expressions work

**US3: Workspace Management**

- `machinum install` initializes workspace
- Directory structure created correctly
- Template files generated
- Idempotent operation

**US4: Cleanup**

- Age-based cleanup works
- Count-based cleanup works
- Active runs protected
- Dry-run mode works

**US5: Checkpoint/Resume**

- Checkpoint persisted on failure
- Resume continues from checkpoint
- State preserved correctly

### Checklists

**Verification Commands**:

```bash
# Run E2E test
./gradlew :core:test --tests "*EndToEndPipelineTest*"

# Run with verbose output
./gradlew :core:test --tests "*EndToEndPipelineTest*" --info

# Verify workspace created during test
ls -la /tmp/ | grep workspace
```

### Plan

1. **Create test class** `EndToEndPipelineTest.java`
2. **Implement full pipeline execution test** (all phases)
3. **Implement environment variable test**
4. **Implement script-based expressions test**
5. **Implement failure and resume test**
6. **Run all tests** and fix any issues
7. **Verify all user stories** are validated

### Quickstart

- `core/src/main/java/machinum/pipeline/PipelineStateMachine.java` - Pipeline execution
- `specs/002-external-tools-support/spec.md` - User stories
- `core/src/test/java/machinum/pipeline/ResumeFlowTest.java` - Resume test reference

---

## TDD Approach

### 1. Write Comprehensive Test

Create test that exercises all user stories

### 2. Run Test (May Fail Initially)

Test will reveal integration issues

### 3. Fix Integration Points

Ensure all components work together

### 4. Validate User Stories

Verify each user story is satisfied

---

## Result

Link to: `docs/results/5.6-e2e-pipeline-test.result.md`
