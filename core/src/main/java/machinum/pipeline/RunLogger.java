package machinum.pipeline;

import java.time.Duration;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.Marker;
import org.slf4j.MarkerFactory;

/** Emits structured run logs with run id, item id, state, tool, and duration fields. */
@Slf4j
@RequiredArgsConstructor(access = AccessLevel.PRIVATE)
public class RunLogger {

  private final String runId;

  public static RunLogger of(String runId) {
    return new RunLogger(runId);
  }

  /** Logs a run-level event. */
  public void runInfo(String message) {
    log.info(createMarker("run"), "[run={}] {}", runId, message);
  }

  /** Logs a run-level error. */
  public void runError(String message, Throwable t) {
    log.error(createMarker("run"), "[run={}] {}", runId, message, t);
  }

  /** Logs an item-level event. */
  public void itemInfo(String itemId, String message) {
    log.info(createMarker("item"), "[run={}] [item={}] {}", runId, itemId, message);
  }

  /** Logs an item-level error. */
  @Deprecated(forRemoval = true)
  public void itemError(String itemId, String message, Throwable t) {
    log.error(createMarker("item"), "[run={}] [item={}] {}", runId, itemId, message, t);
  }

  /** Logs a state transition event. */
  public void stateTransition(String itemId, String fromState, String toState) {
    log.info(
        createMarker("state"),
        "[run={}] [item={}] Transition: {} -> {}",
        runId,
        itemId,
        fromState,
        toState);
  }

  /** Logs a tool execution start. */
  public void toolStart(String itemId, String stateName, String toolName) {
    log.info(
        createMarker("tool"),
        "[run={}] [item={}] [state={}] Starting tool: {}",
        runId,
        itemId,
        stateName,
        toolName);
  }

  /** Logs a tool execution completion with duration. */
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

  /** Logs a tool execution error. */
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

  /** Logs checkpoint persistence event. */
  public void checkpointSaved(String checkpointPath) {
    log.info(createMarker("checkpoint"), "[run={}] Checkpoint saved: {}", runId, checkpointPath);
  }

  /** Logs checkpoint load event. */
  @Deprecated(forRemoval = true)
  public void checkpointLoaded(String checkpointPath) {
    log.info(createMarker("checkpoint"), "[run={}] Checkpoint loaded: {}", runId, checkpointPath);
  }

  private Marker createMarker(String name) {
    return MarkerFactory.getMarker(name);
  }
}
