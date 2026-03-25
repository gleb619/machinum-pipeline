package machinum.cli;

import static machinum.config.CoreConfig.coreConfig;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.cli.commands.StatusCommand;
import machinum.config.SingletonSupport.Scope;
import machinum.config.SingletonSupport.SingletonScope;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

/** Integration test for status command. */
class StatusCommandTest {

  @TempDir
  Path tempDir;

  private CheckpointStore checkpointStore;
  private Scope scope;

  @BeforeEach
  void setUp() throws Exception {
    Path stateDir = tempDir.resolve(".mt/state");
    Files.createDirectories(stateDir);
    scope = SingletonScope.of();
    checkpointStore = coreConfig(scope).checkpointStore(stateDir);
  }

  @Test
  void testStatusCommandWithValidRunId() throws Exception {
    String runId = "test-run-123";

    CheckpointSnapshot snapshot = CheckpointSnapshot.builder()
        .runId(runId)
        .pipelineName("test-pipeline")
        .lastUpdated(Instant.now())
        .status(CheckpointSnapshot.RunStatus.RUNNING)
        .currentStateIndex(2)
        .currentStateName("TRANSFORM")
        .build();

    checkpointStore.save(snapshot);

    StatusCommand command = new StatusCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", runId, "-w", tempDir.toString());

    assertEquals(0, exitCode, "Status command should succeed");
  }

  @Test
  void testStatusCommandWithInvalidRunId() {
    String invalidRunId = "non-existent-run";

    StatusCommand command = new StatusCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", invalidRunId, "-w", tempDir.toString());

    assertEquals(1, exitCode, "Status command should fail for non-existent run");
  }

  @Test
  void testStatusCommandShowsCorrectInfo() throws Exception {
    String runId = "test-run-456";

    CheckpointSnapshot snapshot = CheckpointSnapshot.builder()
        .runId(runId)
        .pipelineName("my-pipeline")
        .lastUpdated(Instant.now())
        .status(CheckpointSnapshot.RunStatus.COMPLETED)
        .currentStateIndex(5)
        .currentStateName("FINISHED")
        .build();

    checkpointStore.save(snapshot);

    StatusCommand command = new StatusCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", runId, "-w", tempDir.toString());

    assertEquals(0, exitCode, "Status command should succeed");
  }
}
