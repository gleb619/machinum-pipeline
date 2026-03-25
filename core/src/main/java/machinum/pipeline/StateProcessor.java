package machinum.pipeline;

import java.time.Instant;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.runner.OneStepRunner;
import machinum.tool.Tool;
import machinum.tool.ToolRegistry;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;

/** Processes pipeline states by evaluating conditions and invoking tools. */
@Slf4j
@RequiredArgsConstructor
public class StateProcessor {

  private final ToolRegistry toolRegistry;
  private final RunLogger runLogger;
  private final OneStepRunner stepRunner;

  /**
   * Processes a single state for an item.
   *
   * @param state the state to process
   * @param stateIndex the state index
   * @param itemId the item identifier
   * @param context the execution itemContext
   * @throws Exception if processing fails
   */
  public void processState(
      StateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception {
    log.debug("Processing state {} (index {}) for item {}", state.name(), stateIndex, itemId);
    stepRunner.executeState(state, stateIndex, itemId, context);
  }

  /**
   * Processes all tools in a state without condition evaluation.
   *
   * @param tools the tools to execute
   * @param stateName the state name
   * @param itemId the item identifier
   * @param context the execution itemContext
   * @throws Exception if any tool fails
   */
  public void processTools(
      List<ToolDefinition> tools, String stateName, String itemId, ExecutionContext context)
      throws Exception {
    for (ToolDefinition toolDef : tools) {
      Tool tool = toolRegistry
          .resolve(toolDef.name())
          .orElseThrow(() -> new IllegalStateException(
              "Tool not found: %s in state: %s".formatted(toolDef.name(), stateName)));

      Instant toolStart = Instant.now();
      runLogger.toolStart(itemId, stateName, toolDef.name());

      try {
        Tool.ToolResult result = tool.execute(context);
        Instant toolEnd = Instant.now();

        if (result.success()) {
          runLogger.toolComplete(itemId, stateName, toolDef.name(), toolStart, toolEnd);
        } else {
          throw new RuntimeException("Tool failed: " + toolDef.name());
        }
      } catch (Exception e) {
        runLogger.toolError(itemId, stateName, toolDef.name(), e);
        throw e;
      }
    }
  }
}
