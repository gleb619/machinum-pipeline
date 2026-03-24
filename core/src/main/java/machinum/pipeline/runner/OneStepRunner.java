package machinum.pipeline.runner;

import java.time.Instant;
import lombok.RequiredArgsConstructor;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;
import machinum.tool.Tool;
import machinum.tool.ToolRegistry;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;

/** Sequential runner strategy for executing pipeline states one step at a time. */
@RequiredArgsConstructor
public class OneStepRunner {

  private final ToolRegistry toolRegistry;
  private final RunLogger runLogger;

  /**
   * Executes a single state with all its tools.
   *
   * @param state the state to execute
   * @param stateIndex the state index
   * @param itemId the item being processed
   * @param context the execution itemContext
   * @throws Exception if execution fails
   */
  public void executeState(
      StateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception {
    //TODO: replace with groovy expression resolver
    TempExpressionResolver resolver = new TempExpressionResolver(context);

    if (state.condition() != null && !resolver.evaluateCondition(state.condition())) {
      runLogger.itemInfo(itemId, "Skipping state " + state.name() + " due to condition");
      return;
    }

    for (ToolDefinition toolDef : state.tools()) {
      Tool tool = toolRegistry.resolve(toolDef.name())
          .orElseThrow(() -> new IllegalStateException(
              "Tool not found: %s in state: %s".formatted(toolDef.name(), state.name())));

      Instant toolStart = Instant.now();
      runLogger.toolStart(itemId, state.name(), toolDef.name());

      try {
        Tool.ToolResult result = tool.execute(context);
        Instant toolEnd = Instant.now();

        if (result.success()) {
          runLogger.toolComplete(itemId, state.name(), toolDef.name(), toolStart, toolEnd);
        } else {
          runLogger.toolError(
              itemId, state.name(), toolDef.name(), new RuntimeException(result.errorMessage()));
          throw new RuntimeException(
              "Tool failed: " + toolDef.name() + " - " + result.errorMessage());
        }
      } catch (Exception e) {
        Instant toolEnd = Instant.now();
        runLogger.toolError(itemId, state.name(), toolDef.name(), e);
        throw e;
      }
    }
  }

  /** Simple expression resolver for state conditions. */
  //TODO: add real one
  @Deprecated(forRemoval = true)
  private static class TempExpressionResolver {
    private final ExecutionContext context;

    TempExpressionResolver(ExecutionContext context) {
      this.context = context;
    }

    public boolean evaluateCondition(String condition) {
      if (condition == null || condition.isBlank()) {
        return true;
      }

      if ("true".equalsIgnoreCase(condition)) {
        return true;
      }
      if ("false".equalsIgnoreCase(condition)) {
        return false;
      }

      return context
          .get(condition)
          .map(val -> "true".equalsIgnoreCase(val.toString()))
          .orElse(false);
    }
  }
}
