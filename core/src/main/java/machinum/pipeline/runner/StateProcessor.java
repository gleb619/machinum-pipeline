package machinum.pipeline.runner;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.Tool;
import machinum.ToolRegistry;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;
import machinum.yaml.ToolDefinition;

@Slf4j
@RequiredArgsConstructor
public class StateProcessor {

  private final ToolRegistry toolRegistry;
  private final RunLogger runLogger;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final Map<String, String> environmentVariables;
  private final Map<String, Object> pipelineVariables;

  public void processTools(
      List<ToolDefinition> tools, String stateName, String itemId, ExecutionContext context)
      throws Exception {
    for (ToolDefinition toolDef : tools) {
      Tool tool = toolRegistry
          .resolve(toolDef.name())
          .orElseThrow(() -> new IllegalStateException(
              "Tool not found: %s in state: %s".formatted(toolDef.name(), stateName)));

      ExpressionContext exprContext = createExpressionContext(itemId, context, toolDef);

      //TODO: Unused
      @Deprecated(forRemoval = true)
      ToolDefinition resolvedToolDef = resolveToolConfig(toolDef, exprContext);

      Instant toolStart = Instant.now();
      runLogger.toolStart(itemId, stateName, toolDef.name());

      try {
        Tool.ToolResult result = tool.execute(context);
        Instant toolEnd = Instant.now();

        if (result.success()) {
          runLogger.toolComplete(itemId, stateName, toolDef.name(), toolStart, toolEnd);
        } else {
          runLogger.toolError(
              itemId, stateName, toolDef.name(), new RuntimeException(result.errorMessage()));
          throw new RuntimeException(
              "Tool failed: " + toolDef.name() + " - " + result.errorMessage());
        }
      } catch (Exception e) {
        runLogger.toolError(itemId, stateName, toolDef.name(), e);
        throw e;
      }
    }
  }

  private ExpressionContext createExpressionContext(
      @Deprecated(forRemoval = true) String itemId, ExecutionContext context, ToolDefinition tool) {
    Map<String, Object> currentItem =
        (Map<String, Object>) context.get("currentItem").orElse(Map.of());
    String textContent = getTextContent(currentItem);

    return ExpressionContext.builder()
        .item(currentItem)
        .text(textContent)
        .index((Integer) context.get("index", 0))
        .textLength(textContent.length())
        .textWords(calculateTextWords(textContent))
        .textTokens(calculateTextTokens(textContent))
        .aggregationIndex((Integer) context.get("aggregationIndex", 0))
        .aggregationText((String) context.get("aggregationText", ""))
        .runId((String) context.get("runId", ""))
        .state(null)
        .tool(tool)
        .retryAttempt((Integer) context.get("retryAttempt", 0))
        .env(environmentVariables)
        .variables(pipelineVariables)
        .scripts(scriptRegistry)
        .build();
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  private ToolDefinition resolveToolConfig(ToolDefinition toolDef, ExpressionContext exprContext) {
    // TODO: Implement tool config resolution when ToolDefinition supports expression-based configs
    return toolDef;
  }

  private String getTextContent(Map<String, Object> item) {
    if (item == null) {
      return "";
    }

    Object content = item.get("content");
    if (content instanceof String) {
      return (String) content;
    }

    for (String field : new String[] {"text", "body", "data"}) {
      Object value = item.get(field);
      if (value instanceof String) {
        return (String) value;
      }
    }

    return "";
  }

  private int calculateTextWords(String text) {
    if (text == null || text.trim().isEmpty()) {
      return 0;
    }
    return text.split("\\s+").length;
  }

  private int calculateTextTokens(String text) {
    if (text == null || text.isEmpty()) {
      return 0;
    }
    return (int) Math.ceil(text.length() / 4.0);
  }
}
