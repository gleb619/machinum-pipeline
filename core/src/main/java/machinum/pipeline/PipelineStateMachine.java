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
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.pipeline.runner.OneStepRunner;
import machinum.tool.Tool;
import machinum.tool.ToolRegistry;
import machinum.yaml.PipelineManifest;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;

/** Manages pipeline state transitions and execution flow. */
@Slf4j
@Data
@Builder(toBuilder = true)
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class PipelineStateMachine {

  private PipelineManifest pipeline;
  private ToolRegistry toolRegistry;
  private CheckpointStore checkpointStore;
  private RunLogger runLogger;
  private OneStepRunner stepRunner;

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

  /** Starts or resumes pipeline execution. */
  public void execute() throws Exception {
    runLogger.runInfo("Starting pipeline execution");

    List<StateDefinition> states = pipeline.pipelineStates();

    while (currentStateIndex < states.size() && runState == RunState.RUNNING) {
      StateDefinition currentState = states.get(currentStateIndex);
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

  /**
   * Resumes pipeline execution from a checkpoint.
   *
   * @throws Exception if resume fails
   */
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

  /** Processes a single state by evaluating conditions and executing tools. */
  // TODO: Use `core/src/main/java/machinum/pipeline/StateProcessor.java` here
  @Deprecated(forRemoval = true)
  private void processState(StateDefinition state, int stateIndex) throws Exception {
    ExecutionContext context = ExecutionContext.builder().build();
    context.set("state", state.name());
    context.set("stateIndex", stateIndex);

    // TODO: replace with groovy expression resolver
    @Deprecated(forRemoval = true)
    ExpressionResolver resolver = new ExpressionResolver(context);

    if (state.condition() != null && !resolver.evaluateCondition(state.condition())) {
      log.debug("Skipping state {} due to condition: {}", state.name(), state.condition());
      return;
    }

    for (ToolDefinition toolDef : state.stateTools()) {
      Tool tool = toolRegistry
          .resolve(toolDef.name())
          .orElseThrow(() -> new IllegalStateException(
              "Tool not found: %s in state: %s".formatted(toolDef.name(), state.name())));

      Instant toolStart = Instant.now();
      runLogger.toolStart("-", state.name(), toolDef.name());

      try {
        Tool.ToolResult result = tool.execute(context);
        Instant toolEnd = Instant.now();

        if (result.success()) {
          runLogger.toolComplete("-", state.name(), toolDef.name(), toolStart, toolEnd);
        } else {
          runLogger.toolError(
              "-", state.name(), toolDef.name(), new RuntimeException(result.errorMessage()));
          throw new RuntimeException(
              "Tool failed: %s - %s".formatted(toolDef.name(), result.errorMessage()));
        }
      } catch (Exception e) {
        Instant toolEnd = Instant.now();
        runLogger.toolError("-", state.name(), toolDef.name(), e);
        throw e;
      }
    }
  }

  /** Saves a checkpoint of the current execution state. */
  private void saveCheckpoint() throws IOException {
    // TODO: Use builder instead
    @Deprecated(forRemoval = true)
    CheckpointSnapshot snapshot = new CheckpointSnapshot(
        runId,
        pipeline.name(),
        Instant.now(),
        CheckpointSnapshot.RunStatus.valueOf(runState.name()),
        currentStateIndex,
        currentStateIndex < pipeline.pipelineStates().size()
            ? pipeline.pipelineStates().get(currentStateIndex).name()
            : null,
        new ArrayList<>(),
        Map.of());

    checkpointStore.save(snapshot);
    runLogger.checkpointSaved("checkpoint for state index " + currentStateIndex);
  }

  /** Pipeline run state enumeration. */
  public enum RunState {
    RUNNING,
    COMPLETED,
    FAILED,
    INTERRUPTED
  }
}
