package machinum.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Files;
import java.nio.file.Path;
import machinum.cli.commands.LogsCommand;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

/** Integration test for logs command. */
class LogsCommandIT {

  @TempDir
  Path tempDir;

  private Path logDir;

  @BeforeEach
  void setUp() throws Exception {
    logDir = tempDir.resolve(".mt/logs");
    Files.createDirectories(logDir);
  }

  @Test
  void testLogsCommandWithValidRunId() throws Exception {
    String runId = "test-run-logs-123";
    Path runLogDir = logDir.resolve(runId);
    Files.createDirectories(runLogDir);

    Path logFile = runLogDir.resolve("run-test-run-logs-123.log");
    Files.writeString(logFile, "2026-03-25 10:00:00 INFO - Starting pipeline\n");

    LogsCommand command = new LogsCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", runId, "-w", tempDir.toString());

    assertEquals(0, exitCode, "Logs command should succeed");
  }

  @Test
  void testLogsCommandWithInvalidRunId() {
    String invalidRunId = "non-existent-run";

    LogsCommand command = new LogsCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", invalidRunId, "-w", tempDir.toString());

    assertEquals(1, exitCode, "Logs command should fail for non-existent run");
  }

  @Test
  void testLogsCommandWithMultipleLogFiles() throws Exception {
    String runId = "test-run-multi-logs";
    Path runLogDir = logDir.resolve(runId);
    Files.createDirectories(runLogDir);

    Path logFile1 = runLogDir.resolve("run-test-run-multi-logs-1.log");
    Files.writeString(logFile1, "Log entry 1\n");

    Path logFile2 = runLogDir.resolve("run-test-run-multi-logs-2.log");
    Files.writeString(logFile2, "Log entry 2\n");

    LogsCommand command = new LogsCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", runId, "-w", tempDir.toString());

    assertEquals(0, exitCode, "Logs command should succeed with multiple log files");
  }

  @Test
  void testLogsCommandWithNoLogFiles() throws Exception {
    String runId = "test-run-empty-logs";
    Path runLogDir = logDir.resolve(runId);
    Files.createDirectories(runLogDir);

    LogsCommand command = new LogsCommand();
    CommandLine commandLine = new CommandLine(command);

    int exitCode = commandLine.execute("--run-id", runId, "-w", tempDir.toString());

    assertEquals(0, exitCode, "Logs command should succeed even with no log files");
  }
}
