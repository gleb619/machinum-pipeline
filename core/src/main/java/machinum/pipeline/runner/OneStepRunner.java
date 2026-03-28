package machinum.pipeline.runner;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import machinum.definition.PipelineStateDefinition;
import machinum.definition.ToolDefinition;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ExecutionContext;
import machinum.pipeline.RunLogger;

@RequiredArgsConstructor
public class OneStepRunner implements StateRunner {

  private final RunLogger runLogger;
  private final StateProcessor stateProcessor;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final Map<String, String> environmentVariables;
  private final Map<String, Object> pipelineVariables;

  @Override
  public void executeState(
      PipelineStateDefinition state,
      @Deprecated(forRemoval = true) int stateIndex,
      String itemId,
      ExecutionContext context)
      throws Exception {

    // TODO: rewrite class
  }

  private ExpressionContext createExpressionContext(
      @Deprecated(forRemoval = true) String itemId,
      ExecutionContext context,
      PipelineStateDefinition state,
      ToolDefinition tool) {
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
        .state(state)
        .tool(tool)
        .retryAttempt((Integer) context.get("retryAttempt", 0))
        .env(environmentVariables)
        .variables(pipelineVariables)
        .scripts(scriptRegistry)
        .build();
  }

  // TODO: We need to use a compiledValue here
  @Deprecated(forRemoval = true)
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
