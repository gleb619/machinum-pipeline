package machinum.pipeline;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import machinum.ToolRegistry;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.expression.ExpressionResolver;
import machinum.manifest.PipelineManifest;
import machinum.manifest.PipelineStateManifest;
import machinum.pipeline.runner.StateRunner;

@Slf4j
@Data
@Builder(toBuilder = true)
@AllArgsConstructor(access = AccessLevel.PRIVATE)
// TODO: Use OneStepRunner Instead
@Deprecated(forRemoval = true)
public class PipelineStateMachine {

  private PipelineManifest pipeline;
  private ToolRegistry toolRegistry;
  private CheckpointStore checkpointStore;
  private RunLogger runLogger;
  private StateRunner stateRunner;
  private ExpressionResolver expressionResolver;

  // TODO: Create paramObject move it from class state in argument instead
  @Deprecated(forRemoval = true)
  @Builder.Default
  private String runId = UUID.randomUUID().toString();

  // TODO: Create paramObject move it from class state in argument instead
  @Deprecated(forRemoval = true)
  @Builder.Default
  private int currentStateIndex = 0;

  // TODO: Create paramObject move it from class state in argument instead
  @Deprecated(forRemoval = true)
  @Builder.Default
  private RunState runState = RunState.RUNNING;

  public void execute() throws Exception {
    runLogger.runInfo("Starting pipeline execution");

    List<PipelineStateManifest> states = pipeline.body().states();

    while (currentStateIndex < states.size() && runState == RunState.RUNNING) {
      PipelineStateManifest currentState = states.get(currentStateIndex);
      runLogger.stateTransition("-", "previous", currentState.name());

      Instant stateStart = Instant.now();

      try {
        processState(currentState, currentStateIndex);
        currentStateIndex++;

        Instant stateEnd = Instant.now();
        long duration = Duration.between(stateStart, stateEnd).toMillis();
        log.debug("State {} completed in {}ms", currentState.name(), duration);

        saveCheckpoint();
      } catch (Exception e) {
        runState = RunState.FAILED;
        runLogger.runError("Pipeline failed at state: " + currentState.name(), e);
        saveCheckpoint();
        throw e;
      }
    }

    if (runState == RunState.RUNNING) {
      runState = RunState.COMPLETED;
      runLogger.runInfo("Pipeline completed successfully");
      saveCheckpoint();
    }
  }

  public void resume() throws Exception {
    CheckpointSnapshot snapshot = checkpointStore
        .load(runId)
        .orElseThrow(() -> new IllegalStateException("No checkpoint found for run: " + runId));

    if (snapshot.status() == CheckpointSnapshot.RunStatus.COMPLETED) {
      runLogger.runInfo("Run already completed, nothing to resume");
      return;
    }

    if (snapshot.status() == CheckpointSnapshot.RunStatus.FAILED) {
      runLogger.runInfo("Resuming failed run from checkpoint");
    }

    currentStateIndex = snapshot.currentStateIndex();
    runState = RunState.RUNNING;

    runLogger.runInfo("Resumed from checkpoint at state index: " + currentStateIndex);

    execute();
  }

  // TODO: Use `core/src/main/java/machinum/pipeline/StateProcessor.java` here
  @Deprecated(forRemoval = true)
  private void processState(PipelineStateManifest state, int stateIndex) throws Exception {
    // TODO: rewrite class
  }

  private void saveCheckpoint() throws IOException {
    // TODO: Use builder instead
    @Deprecated(forRemoval = true)
    CheckpointSnapshot snapshot = new CheckpointSnapshot(
        runId,
        pipeline.name(),
        Instant.now(),
        CheckpointSnapshot.RunStatus.valueOf(runState.name()),
        currentStateIndex,
        currentStateIndex < pipeline.body().states().size()
            ? pipeline.body().states().get(currentStateIndex).name()
            : null,
        new ArrayList<>(),
        Map.of());

    checkpointStore.save(snapshot);
    runLogger.checkpointSaved("checkpoint for state index " + currentStateIndex);
  }

  public enum RunState {
    RUNNING,
    COMPLETED,
    FAILED,
    INTERRUPTED
  }
}
