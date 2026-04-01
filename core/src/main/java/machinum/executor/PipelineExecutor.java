package machinum.executor;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition;
import machinum.executor.LifecycleContext.LifecyclePhase;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ErrorHandler;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;
import machinum.pipeline.runner.OneStepRunner;
import machinum.streamer.ItemsStreamer;
import machinum.streamer.SourceStreamer;
import machinum.streamer.Streamer;
import machinum.tool.ToolRegistry;

@Slf4j
@RequiredArgsConstructor
public class PipelineExecutor {

  private final ToolRegistry toolRegistry;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final ErrorHandler errorHandler;

  public LifecycleContext executeRun(LifecycleContext ctx, PipelineDefinition pipeline) {
    log.info("Starting RUN lifecycle: pipeline={} in {}", pipeline.name(), ctx.workspaceDir());

    List<Map<String, Object>> items = streamItems(pipeline, ctx.workspaceDir());
    log.info("Loaded {} items for processing", items.size());

    RunLogger runLogger = RunLogger.of(ctx.runId());
    Map<String, Object> pipelineVariables =
        pipeline.body().variables() != null ? pipeline.body().variables().get() : Map.of();

    OneStepRunner runner = new OneStepRunner(
        runLogger,
        toolRegistry,
        expressionResolver,
        scriptRegistry,
        errorHandler,
        Map.of(),
        pipelineVariables);

    ExecutionContext execCtx = buildExecutionContext(ctx, pipeline);
    int processed = 0;
    int failed = 0;

    for (int itemIndex = 0; itemIndex < items.size(); itemIndex++) {
      Map<String, Object> item = items.get(itemIndex);
      String itemId = (String) item.getOrDefault("id", "item-" + itemIndex);
      execCtx.updateItem(item, itemIndex);

      log.debug("Processing item {}/{}: {}", itemIndex + 1, items.size(), itemId);
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
          failed++;
          break;
        }
      }

      if (!itemFailed) {
        processed++;
        runLogger.itemInfo(itemId, "Processing completed");
      }
    }

    log.info("RUN lifecycle completed: processed={}, failed={}", processed, failed);

    return ctx.toBuilder().currentPhase(LifecyclePhase.COMPLETE).build();
  }

  private List<Map<String, Object>> streamItems(PipelineDefinition pipeline, Path workspaceDir) {
    Streamer streamer = createStreamer(pipeline);
    return streamer.stream(workspaceDir);
  }

  private Streamer createStreamer(PipelineDefinition pipeline) {
    if (pipeline.body().source() != null) {
      return new SourceStreamer(pipeline.body().source());
    } else if (pipeline.body().items() != null) {
      return new ItemsStreamer(pipeline.body().items());
    }
    throw new IllegalStateException("Pipeline must have either 'source' or 'items'");
  }

  private ExecutionContext buildExecutionContext(
      LifecycleContext ctx, PipelineDefinition pipeline) {
    Map<String, Object> variables =
        pipeline.body().variables() != null ? pipeline.body().variables().get() : Map.of();
    return ExecutionContext.builder()
        .runId(ctx.runId())
        .variables(variables)
        .environment(Map.of())
        .build();
  }
}
