package machinum.executor;

import static machinum.config.CoreConfig.coreConfig;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
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
import machinum.streamer.StreamerCallback;
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

    AtomicInteger processed = new AtomicInteger();
    AtomicInteger failed = new AtomicInteger();

    Streamer streamer = createStreamer(pipeline);
    StreamCursor cursor = StreamCursor.initial();

    streamer.stream(
        ctx.workspaceDir(),
        cursor,
        new PipelineCallback(ctx, execCtx, runLogger, pipeline, runner, failed, processed),
        error -> {
          log.error(
              "Stream error at offset {}: {}",
              error.cursorAtError().itemOffset(),
              error.message(),
              error.cause());
          runLogger.runError("Stream error: " + error.message(), error.cause());
        });

    log.info("RUN lifecycle completed: processed={}, failed={}", processed.get(), failed.get());

    return ctx.toBuilder().currentPhase(LifecyclePhase.COMPLETE).build();
  }

  private Streamer createStreamer(PipelineDefinition pipeline) {
    if (!pipeline.body().source().isEmpty()) {
      return coreConfig().sourceStreamer(pipeline.body().source());
    } else if (!pipeline.body().items().isEmpty()) {
      return coreConfig().itemsStreamer(pipeline.body().items());
    }

    throw new IllegalStateException("Pipeline must have either 'source' or 'items'");
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

  private class PipelineCallback implements StreamerCallback {

    private final LifecycleContext ctx;
    private final ExecutionContext execCtx;
    private final RunLogger runLogger;
    private final PipelineDefinition pipeline;
    private final OneStepRunner runner;
    private final AtomicInteger failed;
    private final AtomicInteger processed;
    private int totalItems;

    public PipelineCallback(
        LifecycleContext ctx,
        ExecutionContext execCtx,
        RunLogger runLogger,
        PipelineDefinition pipeline,
        OneStepRunner runner,
        AtomicInteger failed,
        AtomicInteger processed) {
      this.ctx = ctx;
      this.execCtx = execCtx;
      this.runLogger = runLogger;
      this.pipeline = pipeline;
      this.runner = runner;
      this.failed = failed;
      this.processed = processed;
      totalItems = 0;
    }

    @Override
    public void onStreamStart(StreamCursor initialCursor) {
      log.info("Stream started: runId={}", ctx.runId());
    }

    @Override
    public boolean onBatch(List<StreamItem> items, StreamCursor cur) {
      log.info(
          "Processing batch of {} items (offset={}, total={})",
          items.size(),
          cur.itemOffset(),
          totalItems);

      for (StreamItem item : items) {
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
            failed.incrementAndGet();
            break;
          }
        }

        if (!itemFailed) {
          processed.incrementAndGet();
          runLogger.itemInfo(itemId, "Processing completed");
        }
      }

      totalItems += items.size();
      return true;
    }

    @Override
    public void onStreamEnd(StreamCursor finalCursor) {
      log.info("Stream ended: runId={}, totalItems={}", ctx.runId(), totalItems);
    }
  }
}
