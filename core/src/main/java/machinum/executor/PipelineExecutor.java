package machinum.executor;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
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
import machinum.streamer.StreamCursor;
import machinum.streamer.StreamItem;
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

    AtomicInteger processed = new AtomicInteger();
    AtomicInteger failed = new AtomicInteger();

    Streamer streamer = createStreamer(pipeline);
    StreamCursor cursor = StreamCursor.initial(ctx.runId());

    // Observer-style streaming — batches pushed by streamer
    streamer.stream(
        ctx.workspaceDir(),
        cursor,
        (items, cur) -> {
          log.info("Processing batch of {} items (offset={})", items.size(), cur.itemOffset());

          for (StreamItem item : items) {
            String itemId = item.metaOrDefault("id", "item-" + item.index()).toString();
            execCtx.updateItem(toItemMap(item), item.index());

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

          return true; // continue streaming
        },
        error -> {
          log.error(
              "Stream error at offset {}: {}",
              error.cursorAtError().itemOffset(),
              error.message(),
              error.cause());
          runLogger.runError("Stream error: " + error.message(), error.cause());
          // continue — don't break the flow
        });

    log.info("RUN lifecycle completed: processed={}, failed={}", processed.get(), failed.get());

    return ctx.toBuilder().currentPhase(LifecyclePhase.COMPLETE).build();
  }

  /** Converts a {@link StreamItem} to a map for {@link ExecutionContext}. */
  private Map<String, Object> toItemMap(StreamItem item) {
    Map<String, Object> map = new ConcurrentHashMap<>();
    map.put("content", item.content());
    map.put("index", item.index());
    if (item.file() != null) {
      map.put("file", item.file().toString());
    }
    if (item.subIndex() != null) {
      map.put("subIndex", item.subIndex());
    }
    if (item.metadata() != null) {
      map.putAll(item.metadata());
    }
    return map;
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
