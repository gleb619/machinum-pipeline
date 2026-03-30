package machinum.pipeline;

import java.time.Duration;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Marker;
import org.slf4j.MarkerFactory;

@Slf4j
@RequiredArgsConstructor(access = AccessLevel.PRIVATE)
public class RunLogger {

  private final String runId;

  public static RunLogger of(String runId) {
    return new RunLogger(runId);
  }

  public void runInfo(String message) {
    log.info(createMarker("run"), "[run={}] {}", runId, message);
  }

  public void runError(String message, Throwable t) {
    log.error(createMarker("run"), "[run={}] {}", runId, message, t);
  }

  public void itemInfo(String itemId, String message) {
    log.info(createMarker("item"), "[run={}] [item={}] {}", runId, itemId, message);
  }

  public void itemError(String itemId, String message, Throwable t) {
    log.error(createMarker("item"), "[run={}] [item={}] {}", runId, itemId, message, t);
  }

  public void stateTransition(String itemId, String fromState, String toState) {
    log.info(
        createMarker("state"),
        "[run={}] [item={}] Transition: {} -> {}",
        runId,
        itemId,
        fromState,
        toState);
  }

  public void toolStart(String itemId, String stateName, String toolName) {
    log.info(
        createMarker("tool"),
        "[run={}] [item={}] [state={}] Starting tool: {}",
        runId,
        itemId,
        stateName,
        toolName);
  }

  public void toolComplete(
      String itemId, String stateName, String toolName, Instant startTime, Instant endTime) {
    Duration duration = Duration.between(startTime, endTime);
    log.info(
        createMarker("tool"),
        "[run={}] [item={}] [state={}] Completed tool: {} in {}ms",
        runId,
        itemId,
        stateName,
        toolName,
        duration.toMillis());
  }

  public void toolError(String itemId, String stateName, String toolName, Throwable t) {
    log.error(
        createMarker("tool"),
        "[run={}] [item={}] [state={}] Tool failed: {}",
        runId,
        itemId,
        stateName,
        toolName,
        t);
  }

  public void checkpointSaved(String checkpointPath) {
    log.info(createMarker("checkpoint"), "[run={}] Checkpoint saved: {}", runId, checkpointPath);
  }

  @Deprecated(forRemoval = true)
  public void checkpointLoaded(String checkpointPath) {
    log.info(createMarker("checkpoint"), "[run={}] Checkpoint loaded: {}", runId, checkpointPath);
  }

  private Marker createMarker(String name) {
    return MarkerFactory.getMarker(name);
  }
}
