package machinum.cleanup;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Cleanup policy for run state retention.
 *
 * <p>Policies:
 *
 * <ul>
 *   <li>Keep successful runs for N days
 *   <li>Keep failed runs for N days
 *   <li>Keep at most N successful runs
 *   <li>Keep at most N failed runs
 * </ul>
 */
@Slf4j
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CleanupPolicy {

  /** Keep successful runs for this duration. */
  @Builder.Default
  private Duration successRetention = Duration.ofDays(7);

  /** Keep failed runs for this duration. */
  @Builder.Default
  private Duration failedRetention = Duration.ofDays(14);

  /** Keep at most this many successful runs. */
  @Builder.Default
  private Integer maxSuccessfulRuns = 5;

  /** Keep at most this many failed runs. */
  @Builder.Default
  private Integer maxFailedRuns = 10;

  /**
   * Parses a duration string (e.g., "7d", "24h", "1w").
   *
   * @param durationStr the duration string
   * @return the parsed Duration
   */
  public static Duration parseDuration(String durationStr) {
    if (durationStr == null || durationStr.isBlank()) {
      return Duration.ofDays(7);
    }

    String str = durationStr.toLowerCase().trim();

    if (str.matches("\\d+d")) {
      return Duration.ofDays(Long.parseLong(str.replace("d", "")));
    } else if (str.matches("\\d+h")) {
      return Duration.ofHours(Long.parseLong(str.replace("h", "")));
    } else if (str.matches("\\d+w")) {
      return Duration.ofDays(Long.parseLong(str.replace("w", "")) * 7);
    } else if (str.matches("\\d+")) {
      return Duration.ofDays(Long.parseLong(str));
    }

    log.warn("Unknown duration format: {}, defaulting to 7d", durationStr);
    return Duration.ofDays(7);
  }

  /**
   * Determines if a run should be kept based on this policy.
   *
   * @param run the run metadata
   * @param allRuns all runs for count-based retention
   * @return true if the run should be kept
   */
  public boolean shouldKeep(RunMetadata run, List<RunMetadata> allRuns) {
    boolean isSuccess = run.getStatus() == RunStatus.SUCCESS;
    Duration retention = isSuccess ? successRetention : failedRetention;
    int maxRuns = isSuccess ? maxSuccessfulRuns : maxFailedRuns;

    // Age-based retention
    Duration age = getAge(run);
    if (age.compareTo(retention) > 0) {
      log.debug("Run {} exceeds age retention ({} > {})", run.getRunId(), age, retention);
      return false;
    }

    // Count-based retention
    List<RunMetadata> sameStatusRuns = allRuns.stream()
        .filter(r -> r.getStatus() == run.getStatus())
        .sorted((a, b) -> b.getCreatedAt().compareTo(a.getCreatedAt()))
        .limit(maxRuns)
        .toList();

    if (!sameStatusRuns.contains(run)) {
      log.debug(
          "Run {} exceeds count retention (not in top {} of {})",
          run.getRunId(),
          maxRuns,
          run.getStatus());
      return false;
    }

    return true;
  }

  /**
   * Gets the age of a run.
   *
   * @param run the run metadata
   * @return the age duration
   */
  public Duration getAge(RunMetadata run) {
    Instant now = Instant.now();
    Instant createdAt = run.getCreatedAt();
    return Duration.between(createdAt, now);
  }

  /**
   * Gets the age of a run directory from its checkpoint file.
   *
   * @param runDir the run directory
   * @return the age duration, or null if cannot determine
   */
  public static Duration getAge(Path runDir) {
    try {
      Path checkpointFile = runDir.resolve("checkpoint.json");
      if (Files.exists(checkpointFile)) {
        String content = Files.readString(checkpointFile);
        // Simple JSON parsing - in production use Jackson
        int lastModifiedIdx = content.lastIndexOf("\"last-updated\"");
        if (lastModifiedIdx != -1) {
          // Extract timestamp and parse
          // For now, use file modification time
          Instant lastModified = Instant.ofEpochMilli(
              Files.getLastModifiedTime(checkpointFile).toMillis());
          return Duration.between(lastModified, Instant.now());
        }
      }
      // Fallback to directory modification time
      Instant lastModified =
          Instant.ofEpochMilli(Files.getLastModifiedTime(runDir).toMillis());
      return Duration.between(lastModified, Instant.now());
    } catch (Exception e) {
      log.debug("Cannot determine age of {}: {}", runDir, e.getMessage());
      return null;
    }
  }

  /** Run status enumeration. */
  public enum RunStatus {
    RUNNING,
    SUCCESS,
    FAILED,
    STOPPED
  }

  /** Run metadata for cleanup decisions. */
  @Data
  @Builder
  @NoArgsConstructor
  @AllArgsConstructor
  public static class RunMetadata {
    private String runId;
    private RunStatus status;
    private Instant createdAt;
    private Path directory;
  }
}
