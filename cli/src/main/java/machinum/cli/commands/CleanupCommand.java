package machinum.cli.commands;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.Callable;
import lombok.extern.slf4j.Slf4j;
import machinum.cleanup.CleanupPolicy;
import machinum.cleanup.CleanupPolicy.RunMetadata;
import machinum.cleanup.CleanupService;
import machinum.cleanup.RunScanner;
import machinum.workspace.WorkspaceLayout;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/**
 * Cleanup command: removes old run states based on retention policies.
 *
 * <p>Usage:
 *
 * <pre>{@code
 * machinum cleanup                       # Clean based on root config policy
 * machinum cleanup --run-id <id>         # Clean specific run
 * machinum cleanup --older-than 7d       # Clean runs older than 7 days
 * machinum cleanup --dry-run             # Preview without deleting
 * machinum cleanup --force               # Clean active runs
 * }</pre>
 */
@Slf4j
@Command(
    name = "cleanup",
    description = "Clean up old run states and checkpoints",
    mixinStandardHelpOptions = true)
public class CleanupCommand implements Callable<Integer> {

  /** Specific run ID to clean. */
  @Option(
      names = {"--run-id"},
      description = "Clean up a specific run by ID",
      paramLabel = "<run-id>")
  private String runId;

  /** Age-based cleanup. */
  @Option(
      names = {"--older-than"},
      description = "Clean up runs older than specified duration (e.g., 7d, 24h, 1w)",
      paramLabel = "<duration>")
  private String olderThan;

  /** Dry run mode. */
  @Option(
      names = {"--dry-run"},
      description = "Preview what would be cleaned without deleting")
  private boolean dryRun;

  /** Force cleanup of active runs. */
  @Option(
      names = {"--force"},
      description = "Force cleanup of active runs")
  private boolean force;

  /** Workspace root directory. */
  @Option(
      names = {"--workspace", "-w"},
      description = "Workspace root directory (default: current directory)",
      paramLabel = "<path>")
  private String workspace;

  @Override
  public Integer call() throws Exception {
    Path workspaceRoot = resolveWorkspace();
    Path stateDir = new WorkspaceLayout(workspaceRoot).getStateDir();

    if (!stateDir.toFile().exists()) {
      log.info("No state directory found. Nothing to clean.");
      return 0;
    }

    RunScanner scanner = new RunScanner(stateDir);
    CleanupPolicy policy = CleanupPolicy.builder().build();
    CleanupService cleanupService = new CleanupService(scanner, policy);

    if (dryRun) {
      return performDryRun(cleanupService);
    }

    if (runId != null) {
      return cleanupSpecificRun(cleanupService);
    }

    if (olderThan != null) {
      return cleanupByAge(cleanupService);
    }

    // Default: policy-based cleanup
    return performPolicyCleanup(cleanupService);
  }

  /**
   * Performs a dry run to preview cleanup.
   *
   * @param cleanupService the cleanup service
   * @return exit code
   */
  private int performDryRun(CleanupService cleanupService) {
    log.info("Dry run mode - no files will be deleted");

    Duration age = olderThan != null ? parseDuration(olderThan) : null;
    List<RunMetadata> toClean = cleanupService.previewCleanup(age);

    if (toClean.isEmpty()) {
      log.info("No runs would be cleaned up");
      return 0;
    }

    log.info("Would clean up {} runs:", toClean.size());
    for (RunMetadata run : toClean) {
      Duration runAge = CleanupPolicy.getAge(run.getDirectory());
      log.info(
          "  - {} (status: {}, age: {})", run.getRunId(), run.getStatus(), formatDuration(runAge));
    }

    long totalSize =
        toClean.stream().mapToLong(run -> estimateSize(run.getDirectory())).sum();

    log.info("Total: {} runs, {}", toClean.size(), formatSize(totalSize));
    return 0;
  }

  /**
   * Cleans up a specific run by ID.
   *
   * @param cleanupService the cleanup service
   * @return exit code
   */
  private int cleanupSpecificRun(CleanupService cleanupService) {
    try {
      boolean deleted = cleanupService.cleanupRun(runId, force);
      if (deleted) {
        log.info("Successfully cleaned up run: {}", runId);
      } else {
        log.warn("Run not found or already deleted: {}", runId);
        return 1;
      }
      return 0;
    } catch (IllegalStateException e) {
      log.error(e.getMessage());
      log.info("Use --force to clean active runs");
      return 1;
    }
  }

  /**
   * Cleans up runs older than specified duration.
   *
   * @param cleanupService the cleanup service
   * @return exit code
   */
  private int cleanupByAge(CleanupService cleanupService) {
    Duration age = parseDuration(olderThan);
    int cleaned = cleanupService.cleanupOlderThan(age, force);
    log.info("Cleaned up {} runs older than {}", cleaned, olderThan);
    return 0;
  }

  /**
   * Performs policy-based cleanup.
   *
   * @param cleanupService the cleanup service
   * @return exit code
   */
  private int performPolicyCleanup(CleanupService cleanupService) {
    int cleaned = cleanupService.cleanup(force);
    log.info("Policy-based cleanup complete: {} runs removed", cleaned);
    return 0;
  }

  /**
   * Resolves the workspace root directory.
   *
   * @return the workspace root path
   */
  private Path resolveWorkspace() {
    if (workspace == null) {
      return Paths.get(System.getProperty("user.dir"));
    }
    return Paths.get(workspace).toAbsolutePath().normalize();
  }

  /**
   * Parses a duration string.
   *
   * @param durationStr the duration string
   * @return the parsed Duration
   */
  private Duration parseDuration(String durationStr) {
    return CleanupPolicy.parseDuration(durationStr);
  }

  /**
   * Formats a duration for display.
   *
   * @param duration the duration to format
   * @return formatted string
   */
  private String formatDuration(Duration duration) {
    if (duration == null) {
      return "unknown";
    }

    long days = duration.toDays();
    if (days > 0) {
      return days + "d";
    }

    long hours = duration.toHours();
    if (hours > 0) {
      return hours + "h";
    }

    return duration.toMinutes() + "m";
  }

  /**
   * Estimates the size of a directory.
   *
   * @param dir the directory
   * @return size in bytes
   */
  private long estimateSize(Path dir) {
    if (!dir.toFile().exists()) {
      return 0;
    }

    try (var stream = Files.walk(dir)) {
      return stream
          .filter(Files::isRegularFile)
          .mapToLong(path -> {
            try {
              return Files.size(path);
            } catch (Exception e) {
              return 0;
            }
          })
          .sum();
    } catch (Exception e) {
      return 0;
    }
  }

  /**
   * Formats a size in bytes for display.
   *
   * @param size the size in bytes
   * @return formatted string
   */
  private String formatSize(long size) {
    if (size < 1024) {
      return size + "B";
    }
    if (size < 1024 * 1024) {
      return (size / 1024) + "KB";
    }
    if (size < 1024 * 1024 * 1024) {
      return (size / (1024 * 1024)) + "MB";
    }
    return (size / (1024 * 1024 * 1024)) + "GB";
  }
}
