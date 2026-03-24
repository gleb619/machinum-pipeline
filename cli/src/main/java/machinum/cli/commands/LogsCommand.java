package machinum.cli.commands;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Callable;
import java.util.stream.Stream;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/** Command to show run logs. */
@Command(name = "logs", description = "Show run logs")
public class LogsCommand implements Callable<Integer> {

  @Option(
      names = {"--run-id"},
      description = "Run identifier",
      required = true)
  private String runId;

  @Option(
      names = {"-w", "--workspace"},
      description = "Workspace directory",
      defaultValue = ".")
  private String workspace;

  @Override
  public Integer call() throws Exception {
    Path workspaceDir = Path.of(workspace).toAbsolutePath();
    Path logDir = workspaceDir.resolve(".mt/logs").resolve(runId);

    if (!Files.exists(logDir)) {
      System.err.println("No logs found for run: " + runId);
      return 1;
    }

    try (Stream<Path> logFiles = Files.list(logDir)) {
      logFiles.filter(p -> p.toString().endsWith(".log")).sorted().forEach(this::printLogFile);
    }

    return 0;
  }

  private void printLogFile(Path logFile) {
    try {
      System.out.println("=== " + logFile.getFileName() + " ===");
      Files.lines(logFile).forEach(System.out::println);
    } catch (IOException e) {
      System.err.println("Failed to read log file: " + logFile);
    }
  }
}
