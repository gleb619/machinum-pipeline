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

@Slf4j
@RequiredArgsConstructor
public class CleanupService {

  private final RunScanner scanner;

  private final CleanupPolicy policy;

  public int cleanup(boolean force) {
    List<RunMetadata> allRuns = scanner.getAllRuns();
    int cleanedCount = 0;

    for (RunMetadata run : allRuns) {
      if (run.getStatus() == RunStatus.RUNNING && !force) {
        log.debug("Skipping active run: {}", run.getRunId());
        continue;
      }

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

  public int cleanupOlderThan(Duration age, boolean force) {
    List<RunMetadata> oldRuns = scanner.getRunsOlderThan(age);
    int cleanedCount = 0;

    for (RunMetadata run : oldRuns) {
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

  public boolean cleanupRun(String runId, boolean force) {
    RunMetadata run = scanner.getRunById(runId);
    if (run == null) {
      log.warn("Run not found: {}", runId);
      return false;
    }

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

    return toClean.stream().filter(run -> run.getStatus() != RunStatus.RUNNING).toList();
  }

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

  private void deleteDirectory(Path dir) throws IOException {
    if (!Files.exists(dir)) {
      return;
    }

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
