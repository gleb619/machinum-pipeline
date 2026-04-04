package machinum.pipeline.runner;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.definition.PipelineStateDefinition;
import machinum.definition.PipelineStateDefinition.PipelineToolDefinition;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineBody.ErrorStrategy;
import machinum.pipeline.ErrorStrategyResolver;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;
import machinum.tool.Tool.ToolResult;
import machinum.tool.ToolRegistry;

@Slf4j
@RequiredArgsConstructor
public class OneStepRunner implements PipelineRunner {

  private final RunLogger runLogger;
  private final ToolRegistry toolRegistry;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final ErrorStrategyResolver errorStrategyResolver;
  private final FallbackDefinition fallbackConfig;
  private final Map<String, String> environmentVariables;
  private final Map<String, String> pipelineVariables;

  @Override
  public void executeState(
      PipelineStateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception {

    String stateName = state.name().get();
    log.debug("Executing state: {} for item: {}", stateName, itemId);

    if (state.condition() != null && state.condition().get() != null) {
      String condition = state.condition().get();
      boolean shouldExecute = evaluateCondition(condition, context, state);
      if (!shouldExecute) {
        log.debug("Condition not met for state: {}, skipping", stateName);
        return;
      }
    }

    runLogger.stateTransition(itemId, stateIndex > 0 ? "previous" : "-", stateName);
    context.updateContext(context.getCurrentItem(), convertToMap(state), Map.of());

    List<PipelineToolDefinition> tools = state.tools();
    for (PipelineToolDefinition toolDef : tools) {
      processTool(toolDef, stateName, itemId, context);
    }
  }

  private void processTool(
      PipelineToolDefinition toolDef, String stateName, String itemId, ExecutionContext context)
      throws Exception {

    String toolName = toolDef.name().get();
    context.updateContext(
        context.getCurrentItem(), context.getCurrentState(), Map.of("name", toolName));

    Instant toolStart = Instant.now();
    runLogger.toolStart(itemId, stateName, toolName);

    int maxAttempts = errorStrategyResolver.getMaxAttempts(
        fallbackConfig != null ? fallbackConfig.retryConfig() : null);
    int attempt = 0;
    Exception lastException = null;

    while (attempt < maxAttempts) {
      attempt++;
      context.updateRetryAttempt(attempt);

      try {
        ToolResult result = toolRegistry.execute(toolName, context);
        Instant toolEnd = Instant.now();

        if (result.success()) {
          runLogger.toolComplete(itemId, stateName, toolName, toolStart, toolEnd);
          return;
        } else {
          lastException =
              new RuntimeException("Tool failed: " + toolName + " - " + result.errorMessage());
        }
      } catch (Exception e) {
        lastException = e;
        log.warn("Tool {} failed on attempt {}: {}", toolName, attempt, e.getMessage());
      }

      ErrorStrategy strategy = errorStrategyResolver.resolveStrategy(lastException, fallbackConfig);
      switch (strategy) {
        case retry -> {
          if (attempt < maxAttempts) {
            Duration delay = errorStrategyResolver.calculateBackoffDelay(attempt,
                fallbackConfig != null ? fallbackConfig.retryConfig() : null);
            log.debug("Retrying tool {} after {}ms", toolName, delay);
            Thread.sleep(delay);
          }
        }
        case skip -> {
          log.warn("Skipping tool {} due to error: {}", toolName, lastException.getMessage());
          return;
        }
        case stop -> {
          runLogger.toolError(itemId, stateName, toolName, lastException);
          throw lastException;
        }
        case fallback -> {
          log.warn("Fallback not yet implemented for tool {}", toolName);
          runLogger.toolError(itemId, stateName, toolName, lastException);
          throw lastException;
        }
      }
    }

    runLogger.toolError(itemId, stateName, toolName, lastException);
    throw lastException;
  }

  private boolean evaluateCondition(
      String condition, ExecutionContext context, PipelineStateDefinition state) {

    try {
      context.updateContext(context.getCurrentItem(), convertToMap(state), Map.of());

      ExpressionContext exprCtx = ExpressionContext.builder()
          .item(context.getCurrentItem())
          .text(getTextContent(context))
          .index(context.getCurrentIndex())
          .textLength(context.getTextLength())
          .textWords(context.getTextWords())
          .textTokens(context.getTextTokens())
          .aggregationIndex(context.getAggregationIndex())
          .aggregationText(context.getAggregationText())
          .runId(context.getRunId())
          .state(state)
          .tool(null)
          .retryAttempt(context.getRetryAttempt())
          .env(environmentVariables)
          .variables(pipelineVariables)
          .scripts(scriptRegistry)
          .build();

      Object result = expressionResolver.resolveTemplate(condition, exprCtx);
      return Boolean.TRUE.equals(result);
    } catch (Exception e) {
      log.warn("Failed to evaluate condition: {}, defaulting to false", condition, e);
      return false;
    }
  }

  private String getTextContent(ExecutionContext context) {
    return context.getTextContent();
  }

  private Map<String, Object> convertToMap(PipelineStateDefinition state) {
    return Map.of("name", state.name().get());
  }
}
