package machinum.cleanup;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.cleanup.CleanupPolicy.RunMetadata;
import machinum.cleanup.CleanupPolicy.RunStatus;

/** Applies cleanup policies to remove old runs. */
@Slf4j
@RequiredArgsConstructor
public class CleanupService {

  /** Run scanner for enumerating runs. */
  private final RunScanner scanner;

  /** Cleanup policy to apply. */
  private final CleanupPolicy policy;

  /**
   * Cleans up runs based on policy.
   *
   * @param force if true, clean active runs
   * @return number of runs cleaned
   */
  public int cleanup(boolean force) {
    List<RunMetadata> allRuns = scanner.getAllRuns();
    int cleanedCount = 0;

    for (RunMetadata run : allRuns) {
      // Protect active runs unless force is enabled
      if (run.getStatus() == RunStatus.RUNNING && !force) {
        log.debug("Skipping active run: {}", run.getRunId());
        continue;
      }

      // Apply policy
      if (!policy.shouldKeep(run, allRuns)) {
        if (deleteRun(run)) {
          cleanedCount++;
          log.info(
              "Cleaned up run: {} (status: {}, age: {})",
              run.getRunId(),
              run.getStatus(),
              formatDuration(CleanupPolicy.getAge(run.getDirectory())));
        }
      }
    }

    log.info("Cleanup complete: {} runs removed", cleanedCount);
    return cleanedCount;
  }

  /**
   * Cleans up runs older than the specified duration.
   *
   * @param age the minimum age
   * @param force if true, clean active runs
   * @return number of runs cleaned
   */
  public int cleanupOlderThan(Duration age, boolean force) {
    List<RunMetadata> oldRuns = scanner.getRunsOlderThan(age);
    int cleanedCount = 0;

    for (RunMetadata run : oldRuns) {
      // Protect active runs unless force is enabled
      if (run.getStatus() == RunStatus.RUNNING && !force) {
        log.debug("Skipping active run: {}", run.getRunId());
        continue;
      }

      if (deleteRun(run)) {
        cleanedCount++;
        log.info(
            "Cleaned up old run: {} (age: {})",
            run.getRunId(),
            formatDuration(CleanupPolicy.getAge(run.getDirectory())));
      }
    }

    log.info("Age-based cleanup complete: {} runs removed", cleanedCount);
    return cleanedCount;
  }

  /**
   * Cleans up a specific run by ID.
   *
   * @param runId the run ID
   * @param force if true, clean active runs
   * @return true if the run was deleted
   */
  public boolean cleanupRun(String runId, boolean force) {
    RunMetadata run = scanner.getRunById(runId);
    if (run == null) {
      log.warn("Run not found: {}", runId);
      return false;
    }

    // Protect active runs unless force is enabled
    if (run.getStatus() == RunStatus.RUNNING && !force) {
      throw new IllegalStateException(
          "Cannot clean active run " + runId + ". Use --force to override.");
    }

    boolean deleted = deleteRun(run);
    if (deleted) {
      log.info("Cleaned up run: {}", runId);
    }
    return deleted;
  }

  /**
   * Performs a dry run to preview what would be cleaned.
   *
   * @param age optional age filter (null for policy-based)
   * @return list of runs that would be cleaned
   */
  public List<RunMetadata> previewCleanup(Duration age) {
    List<RunMetadata> allRuns = scanner.getAllRuns();
    List<RunMetadata> toClean;

    if (age != null) {
      toClean = scanner.getRunsOlderThan(age);
    } else {
      toClean = allRuns.stream()
          .filter(run -> !policy.shouldKeep(run, allRuns))
          .collect(Collectors.toList());
    }

    // Filter out active runs
    return toClean.stream().filter(run -> run.getStatus() != RunStatus.RUNNING).toList();
  }

  /**
   * Deletes a run directory.
   *
   * @param run the run to delete
   * @return true if deleted successfully
   */
  private boolean deleteRun(RunMetadata run) {
    Path runDir = run.getDirectory();

    if (!Files.exists(runDir)) {
      return false;
    }

    try {
      deleteDirectory(runDir);
      log.debug("Deleted run directory: {}", runDir);
      return true;
    } catch (IOException e) {
      log.error("Failed to delete run: {}", runDir, e);
      return false;
    }
  }

  /**
   * Deletes a directory recursively.
   *
   * @param dir the directory to delete
   * @throws IOException if deletion fails
   */
  private void deleteDirectory(Path dir) throws IOException {
    if (!Files.exists(dir)) {
      return;
    }

    // Delete files first, then subdirectories
    try (var stream = Files.walk(dir)) {
      stream.sorted(Comparator.reverseOrder()).forEach(path -> {
        try {
          Files.delete(path);
        } catch (IOException e) {
          throw new RuntimeException("Failed to delete: " + path, e);
        }
      });
    }
  }

  /**
   * Formats a duration for logging.
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
}
