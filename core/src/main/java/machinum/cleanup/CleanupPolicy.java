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

@Slf4j
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
// TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of
// hardcode
@Deprecated
public class CleanupPolicy {

  @Builder.Default
  private Duration successRetention = Duration.ofDays(7);

  @Builder.Default
  private Duration failedRetention = Duration.ofDays(14);

  @Builder.Default
  private Integer maxSuccessfulRuns = 5;

  @Builder.Default
  private Integer maxFailedRuns = 10;

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

  public boolean shouldKeep(RunMetadata run, List<RunMetadata> allRuns) {
    boolean isSuccess = run.getStatus() == RunStatus.SUCCESS;
    Duration retention = isSuccess ? successRetention : failedRetention;
    int maxRuns = isSuccess ? maxSuccessfulRuns : maxFailedRuns;

    Duration age = getAge(run);
    if (age.compareTo(retention) > 0) {
      log.debug("Run {} exceeds age retention ({} > {})", run.getRunId(), age, retention);
      return false;
    }

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

  public Duration getAge(RunMetadata run) {
    Instant now = Instant.now();
    Instant createdAt = run.getCreatedAt();
    return Duration.between(createdAt, now);
  }

  public static Duration getAge(Path runDir) {
    try {
      Path checkpointFile = runDir.resolve("checkpoint.json");
      if (Files.exists(checkpointFile)) {
        String content = Files.readString(checkpointFile);

        int lastModifiedIdx = content.lastIndexOf("\"last-updated\"");
        if (lastModifiedIdx != -1) {

          Instant lastModified =
              Instant.ofEpochMilli(Files.getLastModifiedTime(checkpointFile).toMillis());
          return Duration.between(lastModified, Instant.now());
        }
      }
      Instant lastModified =
          Instant.ofEpochMilli(Files.getLastModifiedTime(runDir).toMillis());
      return Duration.between(lastModified, Instant.now());
    } catch (Exception e) {
      log.debug("Cannot determine age of {}: {}", runDir, e.getMessage());
      return null;
    }
  }

  public enum RunStatus {
    RUNNING,
    SUCCESS,
    FAILED,
    STOPPED
  }

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
