package machinum.checkpoint;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

/**
 * Captures resumable execution state including state cursor, item progress summary, and links to
 * item payload state.
 */
@Builder
public record CheckpointSnapshot(
    String runId,
    String pipelineName,
    Instant lastUpdated,
    RunStatus status,
    int currentStateIndex,
    String currentStateName,
    @Singular("progress")
    List<ItemProgress> itemProgress,
    @Singular("context")
    Map<String, Object> runContext) {

  /** Represents the status of a run. */
  public enum RunStatus {
    RUNNING,
    COMPLETED,
    FAILED,
    INTERRUPTED
  }

  /** Tracks progress for a single item. */
  @Builder
  public record ItemProgress(
      String itemId,
      int completedStateIndex,
      String lastState,
      ItemStatus status,
      @Singular("context")
      Map<String, Object> itemContext) {
    public enum ItemStatus {
      PENDING,
      IN_PROGRESS,
      COMPLETED,
      FAILED
    }
  }

}
