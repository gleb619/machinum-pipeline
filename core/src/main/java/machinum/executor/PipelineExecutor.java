package machinum.executor;

import static machinum.config.CoreConfig.coreConfig;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.definition.PipelineDefinition;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.executor.PhaseContext.LifecyclePhase;
import machinum.executor.lifecycle.ExecutionPhaseContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ErrorStrategyResolver;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;
import machinum.pipeline.runner.OneStepRunner;
import machinum.streamer.StreamCursor;
import machinum.streamer.StreamItem;
import machinum.streamer.Streamer;
import machinum.tool.ToolRegistry;
import tools.jackson.databind.ObjectMapper;

@Slf4j
@RequiredArgsConstructor
public class PipelineExecutor {

  private final ToolRegistry toolRegistry;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final ErrorStrategyResolver errorStrategyResolver;
  private final ObjectMapper objectMapper;

  public LifecycleContext executeRun(LifecycleContext ctx, PipelineDefinition pipeline) {
    log.info("Starting RUN lifecycle: pipeline={} in {}", pipeline.name(), ctx.workspaceDir());

    RunLogger runLogger = RunLogger.of(ctx.runId());
    Map<String, String> pipelineVariables = pipeline.body().variables().asMap();
    FallbackDefinition fallbackConfig = pipeline.body().fallback();

    OneStepRunner runner = new OneStepRunner(
        runLogger,
        toolRegistry,
        expressionResolver,
        scriptRegistry,
        errorStrategyResolver,
        fallbackConfig,
        Map.of(),
        pipelineVariables);

    ExecutionContext execCtx = buildExecutionContext(ctx, pipeline);
    ctx.registerContext(ExecutionPhaseContext.builder().context(execCtx).build());

    AtomicInteger processedCount = new AtomicInteger();
    AtomicInteger failedCount = new AtomicInteger();

    var checkpointStore = coreConfig().checkpointStore(ctx.workspaceDir().resolve(".machinum/checkpoints"));
    Streamer streamer = createStreamer(pipeline, checkpointStore);

    log.info("Stream processing started: runId={}", ctx.runId());

    try (var streamResult = streamer.stream(ctx.workspaceDir(), ctx.runId())) {
      for (List<StreamItem> batch : streamResult) {
        log.info("Processing batch of {} items", batch.size());

        for (StreamItem item : batch) {
          String itemId = item.metaOrDefault("id", "item-" + item.index()).toString();
          execCtx.updateItem(item);

          log.debug("Processing item {}: {}", item.index(), itemId);
          runLogger.itemInfo(itemId, "Starting processing");

          boolean itemFailed = false;
          for (int stateIndex = 0; stateIndex < pipeline.body().states().size(); stateIndex++) {
            var state = pipeline.body().states().get(stateIndex);
            try {
              runner.executeState(state, stateIndex, itemId, execCtx);
            } catch (Exception e) {
              log.error("Item {} failed at state {}", itemId, state.name().get(), e);
              runLogger.itemError(itemId, "Failed at state: " + state.name().get(), e);
              itemFailed = true;
              failedCount.incrementAndGet();
              break;
            }
          }

          if (!itemFailed) {
            processedCount.incrementAndGet();
            runLogger.itemInfo(itemId, "Processing completed");
          }
        }

        // Save checkpoint after each batch
        saveCheckpoint(checkpointStore, ctx.runId(), streamResult.currentCursor());
      }

      if (streamResult.error().isPresent()) {
        var error = streamResult.error().get();
        log.error("Stream finished with error at offset {}: {}", 
            error.cursorAtError().itemOffset(), error.message());
        runLogger.runError("Stream error: " + error.message(), error.cause());
      }

    } catch (Exception e) {
      log.error("Execution failed", e);
      runLogger.runError("Execution failed: " + e.getMessage(), e);
    }

    log.info("RUN lifecycle completed: processed={}, failed={}", processedCount.get(), failedCount.get());

    return ctx.toBuilder().currentPhase(LifecyclePhase.COMPLETE).build();
  }

  private ExecutionContext buildExecutionContext(
      LifecycleContext ctx, PipelineDefinition pipeline) {
    Map<String, String> variables = pipeline.body().variables().asMap();
    return ExecutionContext.builder()
        .runId(ctx.runId())
        .workspaceRoot(ctx.workspaceDir())
        .variables(variables)
        .environment(Map.of())
        .build();
  }

  private void saveCheckpoint(CheckpointStore store, String runId, StreamCursor cursor) {
    try {
      var snapshot = CheckpointSnapshot.builder()
          .runId(runId)
          .currentStateIndex(cursor.stateIndex())
          .status(CheckpointSnapshot.RunStatus.RUNNING)
          .runContext(Map.of(
              "itemOffset", cursor.itemOffset(),
              "windowId", cursor.windowId()
          ))
          .build();
      store.save(snapshot);
      log.debug("Checkpoint saved for runId={} at offset={}", runId, cursor.itemOffset());
    } catch (IOException e) {
      log.error("Failed to save checkpoint for runId={}", runId, e);
    }
  }

  private Streamer createStreamer(PipelineDefinition pipeline, CheckpointStore checkpointStore) {
    if (!pipeline.body().source().isEmpty()) {
      return coreConfig().sourceStreamer(pipeline.body().source(), checkpointStore);
    } else if (!pipeline.body().items().isEmpty()) {
      return coreConfig().itemsStreamer(pipeline.body().items(), checkpointStore);
    }

    throw new IllegalStateException("Pipeline must have either 'source' or 'items'");
  }
}
