# Task: 5.5-cleanup-integration-test

**Phase**: 5
**Priority**: P1
**Status**: `pending`
**Depends On**: Task 4.1 (CleanupPolicy), Task 4.2 (RunScanner), Task 4.3 (CleanupService), Task 4.4 (CleanupCommand
CLI)
**TDD Reference**: `docs/tdd.md` section 7.2

---

## Description

Create comprehensive integration tests for the cleanup command to verify cleanup with various retention policies,
`--older-than` option, `--run-id` option, `--dry-run` preview mode, active run protection, and policy-based retention.

---

## Acceptance Criteria

- [ ] Test creates mock runs with different ages and statuses (SUCCESS, FAILED, RUNNING)
- [ ] Test verifies `--older-than` removes correct runs
- [ ] Test verifies `--run-id` removes specific run
- [ ] Test verifies policy-based retention (successRetention, failedRetention)
- [ ] Test verifies active run protection (RUNNING status not deleted)
- [ ] Test verifies `--dry-run` preview mode (no files deleted)
- [ ] Test verifies `--force` flag allows cleaning active runs
- [ ] Test verifies count-based retention (maxSuccessfulRuns, maxFailedRuns)
- [ ] Test verifies clear summary output (X runs cleaned, Y retained)

---

## Implementation Notes

### Test Class Structure

```java
package machinum.cleanup;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.FileCheckpointStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

class CleanupCommandIntegrationTest {

  @TempDir
  Path tempDir;

  private Path stateDir;
  private FileCheckpointStore checkpointStore;
  private CommandLine cli;

  @BeforeEach
  void setUp() throws Exception {
    stateDir = tempDir.resolve(".mt/state");
    Files.createDirectories(stateDir);
    checkpointStore = new FileCheckpointStore(stateDir);
    cli = new CommandLine(new machinum.cli.MachinumCli());
  }

  @Test
  void testCleanupOlderThan() throws Exception {
    // Arrange - Create mock runs with different ages
    Instant now = Instant.now();

    // Old run (10 days old)
    createMockRun("run-old-1", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(10, java.time.ChronoUnit.DAYS));
    createMockRun("run-old-2", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(8, java.time.ChronoUnit.DAYS));

    // Recent run (2 days old)
    createMockRun("run-recent", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(2, java.time.ChronoUnit.DAYS));

    // Act - Clean up runs older than 7 days
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d");

    // Assert
    assertEquals(0, exitCode);

    // Verify old runs deleted
    assertFalse(Files.exists(stateDir.resolve("run-old-1")),
        "Old run should be deleted");
    assertFalse(Files.exists(stateDir.resolve("run-old-2")),
        "Old run should be deleted");

    // Verify recent run retained
    assertTrue(Files.exists(stateDir.resolve("run-recent")),
        "Recent run should be retained");
  }

  @Test
  void testCleanupSpecificRunId() throws Exception {
    // Arrange
    Instant now = Instant.now();
    createMockRun("run-to-delete", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(1, java.time.ChronoUnit.DAYS));
    createMockRun("run-to-keep", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(1, java.time.ChronoUnit.DAYS));

    // Act
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--run-id", "run-to-delete");

    // Assert
    assertEquals(0, exitCode);

    // Verify specific run deleted
    assertFalse(Files.exists(stateDir.resolve("run-to-delete")),
        "Specific run should be deleted");

    // Verify other run retained
    assertTrue(Files.exists(stateDir.resolve("run-to-keep")),
        "Other run should be retained");
  }

  @Test
  void testDryRunMode() throws Exception {
    // Arrange
    Instant now = Instant.now();
    createMockRun("run-old", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(10, java.time.ChronoUnit.DAYS));

    // Act
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d",
        "--dry-run");

    // Assert
    assertEquals(0, exitCode);

    // Verify run NOT deleted (dry run)
    assertTrue(Files.exists(stateDir.resolve("run-old")),
        "Run should not be deleted in dry-run mode");
  }

  @Test
  void testActiveRunProtection() throws Exception {
    // Arrange
    Instant now = Instant.now();
    createMockRun("run-running", CheckpointSnapshot.RunStatus.RUNNING, now.minus(10, java.time.ChronoUnit.DAYS));
    createMockRun("run-completed", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(10, java.time.ChronoUnit.DAYS));

    // Act
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d");

    // Assert
    assertEquals(0, exitCode);

    // Verify active run protected
    assertTrue(Files.exists(stateDir.resolve("run-running")),
        "Active run should be protected");

    // Verify completed run deleted
    assertFalse(Files.exists(stateDir.resolve("run-completed")),
        "Completed run should be deleted");
  }

  @Test
  void testForceFlagForActiveRuns() throws Exception {
    // Arrange
    Instant now = Instant.now();
    createMockRun("run-running", CheckpointSnapshot.RunStatus.RUNNING, now.minus(10, java.time.ChronoUnit.DAYS));

    // Act - Force cleanup of active runs
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d",
        "--force");

    // Assert
    assertEquals(0, exitCode);

    // Verify active run deleted with --force
    assertFalse(Files.exists(stateDir.resolve("run-running")),
        "Active run should be deleted with --force flag");
  }

  @Test
  void testPolicyBasedRetention() throws Exception {
    // Arrange - Create root config with retention policy
    Path rootConfig = tempDir.resolve("root.yaml");
    Files.writeString(rootConfig, """
        version: 1.0.0
        cleanup:
          successRetention: 3d
          failedRetention: 7d
          maxSuccessfulRuns: 5
          maxFailedRuns: 10
        """);

    Instant now = Instant.now();
    // Old successful runs
    createMockRun("run-success-old-1", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(5, java.time.ChronoUnit.DAYS));
    createMockRun("run-success-old-2", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(4, java.time.ChronoUnit.DAYS));
    // Recent successful runs
    createMockRun("run-success-recent-1", CheckpointSnapshot.RunStatus.COMPLETED,
        now.minus(1, java.time.ChronoUnit.DAYS));
    createMockRun("run-success-recent-2", CheckpointSnapshot.RunStatus.COMPLETED,
        now.minus(2, java.time.ChronoUnit.DAYS));

    // Old failed runs
    createMockRun("run-failed-old", CheckpointSnapshot.RunStatus.FAILED, now.minus(10, java.time.ChronoUnit.DAYS));
    // Recent failed runs
    createMockRun("run-failed-recent", CheckpointSnapshot.RunStatus.FAILED, now.minus(3, java.time.ChronoUnit.DAYS));

    // Act
    int exitCode = cli.execute("cleanup", "--workspace", tempDir.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify old successful runs deleted (> 3d retention)
    assertFalse(Files.exists(stateDir.resolve("run-success-old-1")));
    assertFalse(Files.exists(stateDir.resolve("run-success-old-2")));

    // Verify recent successful runs retained
    assertTrue(Files.exists(stateDir.resolve("run-success-recent-1")));
    assertTrue(Files.exists(stateDir.resolve("run-success-recent-2")));

    // Verify old failed run deleted (> 7d retention)
    assertFalse(Files.exists(stateDir.resolve("run-failed-old")));

    // Verify recent failed run retained
    assertTrue(Files.exists(stateDir.resolve("run-failed-recent")));
  }

  @Test
  void testCountBasedRetention() throws Exception {
    // Arrange - Create root config with max runs
    Path rootConfig = tempDir.resolve("root.yaml");
    Files.writeString(rootConfig, """
        version: 1.0.0
        cleanup:
          maxSuccessfulRuns: 3
          maxFailedRuns: 2
        """);

    Instant now = Instant.now();
    // Create 5 successful runs
    for (int i = 1; i <= 5; i++) {
      createMockRun("run-success-" + i, CheckpointSnapshot.RunStatus.COMPLETED,
          now.minus(i, java.time.ChronoUnit.DAYS));
    }

    // Create 4 failed runs
    for (int i = 1; i <= 4; i++) {
      createMockRun("run-failed-" + i, CheckpointSnapshot.RunStatus.FAILED,
          now.minus(i, java.time.ChronoUnit.DAYS));
    }

    // Act
    int exitCode = cli.execute("cleanup", "--workspace", tempDir.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify oldest successful runs deleted (keep only 3 most recent)
    assertFalse(Files.exists(stateDir.resolve("run-success-5")));
    assertFalse(Files.exists(stateDir.resolve("run-success-4")));
    assertTrue(Files.exists(stateDir.resolve("run-success-3")));
    assertTrue(Files.exists(stateDir.resolve("run-success-2")));
    assertTrue(Files.exists(stateDir.resolve("run-success-1")));

    // Verify oldest failed runs deleted (keep only 2 most recent)
    assertFalse(Files.exists(stateDir.resolve("run-failed-4")));
    assertFalse(Files.exists(stateDir.resolve("run-failed-3")));
    assertTrue(Files.exists(stateDir.resolve("run-failed-2")));
    assertTrue(Files.exists(stateDir.resolve("run-failed-1")));
  }

  @Test
  void testCleanupSummaryOutput() throws Exception {
    // Arrange
    Instant now = Instant.now();
    createMockRun("run-old-1", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(10, java.time.ChronoUnit.DAYS));
    createMockRun("run-old-2", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(9, java.time.ChronoUnit.DAYS));
    createMockRun("run-recent", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(1, java.time.ChronoUnit.DAYS));

    // Act & Capture Output
    ByteArrayOutputStream outContent = new ByteArrayOutputStream();
    System.setOut(new PrintStream(outContent));

    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d");

    System.setOut(System.out);

    // Assert
    assertEquals(0, exitCode);
    String output = outContent.toString();
    assertTrue(output.contains("2"), "Output should mention 2 runs cleaned");
    assertTrue(output.contains("1"), "Output should mention 1 run retained");
  }

  @Test
  void testCleanupNoRunsToClean() throws Exception {
    // Arrange - Only recent runs
    Instant now = Instant.now();
    createMockRun("run-recent-1", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(1, java.time.ChronoUnit.DAYS));
    createMockRun("run-recent-2", CheckpointSnapshot.RunStatus.COMPLETED, now.minus(2, java.time.ChronoUnit.DAYS));

    // Act
    int exitCode = cli.execute("cleanup",
        "--workspace", tempDir.toString(),
        "--older-than", "7d");

    // Assert
    assertEquals(0, exitCode);

    // Verify all runs retained
    assertTrue(Files.exists(stateDir.resolve("run-recent-1")));
    assertTrue(Files.exists(stateDir.resolve("run-recent-2")));
  }

  // Helper method to create mock run
  private void createMockRun(String runId, CheckpointSnapshot.RunStatus status, Instant startTime)
      throws IOException {
    Path runDir = stateDir.resolve(runId);
    Files.createDirectories(runDir);

    CheckpointSnapshot snapshot = CheckpointSnapshot.builder()
        .runId(runId)
        .pipelineName("test-pipeline")
        .startTime(startTime)
        .endTime(startTime.plus(1, java.time.ChronoUnit.HOURS))
        .status(status)
        .currentStateIndex(5)
        .currentState("COMPLETED")
        .build();

    checkpointStore.save(snapshot);
  }
}
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` section 7.2 - Cleanup Command
- **CleanupPolicy**: `core/src/main/java/machinum/cleanup/CleanupPolicy.java`
- **RunScanner**: `core/src/main/java/machinum/cleanup/RunScanner.java`
- **CleanupService**: `core/src/main/java/machinum/cleanup/CleanupService.java`
- **CleanupCommand**: `cli/src/main/java/machinum/cli/commands/CleanupCommand.java`

**Files to Create**:

- `cli/src/test/java/machinum/cleanup/CleanupCommandIntegrationTest.java`

**Files to Read**:

- `core/src/main/java/machinum/cleanup/CleanupPolicy.java`
- `core/src/main/java/machinum/cleanup/RunScanner.java`
- `core/src/main/java/machinum/cleanup/CleanupService.java`
- `cli/src/main/java/machinum/cli/commands/CleanupCommand.java`

---

## Spec

### Contracts

**CleanupCommand Options**:

```bash
machinum cleanup --older-than 7d           # Age-based cleanup
machinum cleanup --run-id <id>             # Specific run cleanup
machinum cleanup --dry-run                 # Preview mode
machinum cleanup --force                   # Clean active runs
machinum cleanup                           # Policy-based cleanup
```

**Retention Policy Configuration**:

```yaml
version: 1.0.0
cleanup:
  successRetention: 3d      # Keep successful runs for 3 days
  failedRetention: 7d       # Keep failed runs for 7 days
  maxSuccessfulRuns: 5      # Keep max 5 successful runs
  maxFailedRuns: 10         # Keep max 10 failed runs
```

### Checklists

**Verification Commands**:

```bash
# Run cleanup integration tests
./gradlew :cli:test --tests "*CleanupCommandIntegrationTest*"

# Run with verbose output
./gradlew :cli:test --tests "*CleanupCommandIntegrationTest*" --info

# Verify state directory structure
find .mt/state -type d
```

### Plan

1. **Create test class** `CleanupCommandIntegrationTest.java`
2. **Implement helper method** to create mock runs
3. **Implement --older-than test**
4. **Implement --run-id test**
5. **Implement --dry-run test**
6. **Implement active run protection test**
7. **Implement --force flag test**
8. **Implement policy-based retention test**
9. **Implement count-based retention test**
10. **Implement summary output test**
11. **Run all tests** and fix any issues

### Quickstart

- `core/src/main/java/machinum/cleanup/CleanupService.java` - Cleanup logic
- `cli/src/main/java/machinum/cli/commands/CleanupCommand.java` - CLI command
- `cli/src/test/java/machinum/cli/CleanupCommandTest.java` - Existing test for reference

---

## TDD Approach

### 1. Create Mock Run Data

Create helper method to set up runs with different ages and statuses

### 2. Write Failing Tests

Write tests for each cleanup scenario

### 3. Make Tests Pass

Ensure `CleanupCommand` and `CleanupService` work correctly

### 4. Refine and Extend

- Add edge case tests (empty state, corrupted checkpoints)
- Add concurrent cleanup tests
- Add error handling tests (permission denied, disk full)

---

## Result

Link to: `docs/results/5.5-cleanup-integration-test.result.md`
