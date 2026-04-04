package machinum.cleanup;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.cleanup.CleanupPolicy.RunMetadata;
import machinum.cleanup.CleanupPolicy.RunStatus;

@Slf4j
@RequiredArgsConstructor
//TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of hardcode
@Deprecated
public class RunScanner {

  private final Path stateDir;

  public List<RunMetadata> getAllRuns() {
    List<RunMetadata> runs = new ArrayList<>();

    if (!Files.exists(stateDir)) {
      log.debug("State directory does not exist: {}", stateDir);
      return runs;
    }

    try (Stream<Path> paths = Files.list(stateDir)) {
      paths.filter(Files::isDirectory).forEach(dir -> {
        RunMetadata metadata = loadRunMetadata(dir);
        if (metadata != null) {
          runs.add(metadata);
        }
      });
    } catch (IOException e) {
      log.error("Failed to scan state directory: {}", stateDir, e);
    }

    log.debug("Found {} runs in {}", runs.size(), stateDir);
    return runs;
  }

  public List<RunMetadata> getRunsOlderThan(Duration age) {
    List<RunMetadata> oldRuns = new ArrayList<>();

    for (RunMetadata run : getAllRuns()) {
      Duration runAge = CleanupPolicy.getAge(run.getDirectory());
      if (runAge != null && runAge.compareTo(age) > 0) {
        oldRuns.add(run);
      }
    }

    log.debug("Found {} runs older than {}", oldRuns.size(), age);
    return oldRuns;
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public List<RunMetadata> getRunsByStatus(RunStatus status) {
    List<RunMetadata> filtered = new ArrayList<>();

    for (RunMetadata run : getAllRuns()) {
      if (run.getStatus() == status) {
        filtered.add(run);
      }
    }

    log.debug("Found {} runs with status {}", filtered.size(), status);
    return filtered;
  }

  public RunMetadata getRunById(String runId) {
    Path runDir = stateDir.resolve(runId);
    if (!Files.exists(runDir)) {
      return null;
    }
    return loadRunMetadata(runDir);
  }

  private RunMetadata loadRunMetadata(Path runDir) {
    try {
      String runId = runDir.getFileName().toString();
      Path checkpointFile = runDir.resolve("checkpoint.json");

      RunStatus status = RunStatus.RUNNING;
      Instant createdAt = Instant.now();

      if (Files.exists(checkpointFile)) {
        String content = Files.readString(checkpointFile);

        if (content.contains("\"status\": \"success\"")) {
          status = RunStatus.SUCCESS;
        } else if (content.contains("\"status\": \"failed\"")) {
          status = RunStatus.FAILED;
        } else if (content.contains("\"status\": \"stopped\"")) {
          status = RunStatus.STOPPED;
        }

        int startedIdx = content.indexOf("\"started-at\"");
        if (startedIdx != -1) {
          int colonIdx = content.indexOf(':', startedIdx);
          if (colonIdx != -1) {
            int quoteStart = content.indexOf('"', colonIdx + 1);
            if (quoteStart != -1) {
              int quoteEnd = content.indexOf('"', quoteStart + 1);
              if (quoteEnd != -1) {
                String timestamp = content.substring(quoteStart + 1, quoteEnd);
                try {
                  createdAt = Instant.parse(timestamp);
                } catch (Exception e) {
                  log.debug("Cannot parse timestamp: {}", timestamp);
                }
              }
            }
          }
        }
      }

      return RunMetadata.builder()
          .runId(runId)
          .status(status)
          .createdAt(createdAt)
          .directory(runDir)
          .build();
    } catch (IOException e) {
      log.error("Failed to load metadata for run: {}", runDir, e);
      return null;
    }
  }
}
