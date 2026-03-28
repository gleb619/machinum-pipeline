package machinum.pipeline;

import java.util.Map;
import java.util.Optional;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;

@AllArgsConstructor
@Builder(toBuilder = true)
@Getter
public class EnhancedExecutionContext {

  private final String runId;

  private final Map<String, Object> metadata;

  private final Map<String, Object> variables;

  private final Map<String, String> environment;

  private final ExpressionResolver expressionResolver;

  private final ScriptRegistry scriptRegistry;

  private Map<String, Object> currentItem;

  private StateDefinition currentState;

  private ToolDefinition currentTool;

  private int currentIndex;

  private int retryAttempt;

  private int aggregationIndex;

  private String aggregationText;

  public Object evaluate(String template) {
    if (expressionResolver == null) {
      return template;
    }

    var expressionContext = ExpressionContext.builder()
        .item(currentItem)
        .text(getTextContent())
        .index(currentIndex)
        .textLength(calculateTextLength())
        .textWords(calculateTextWords())
        .textTokens(calculateTextTokens())
        .aggregationIndex(aggregationIndex)
        .aggregationText(aggregationText)
        .runId(runId)
        .state(currentState)
        .tool(currentTool)
        .retryAttempt(retryAttempt)
        .env(environment)
        .variables(variables)
        .scripts(scriptRegistry)
        .build();

    return expressionResolver.resolveTemplate(template, expressionContext);
  }

  public boolean hasExpressions(String value) {
    return expressionResolver != null && expressionResolver.supportsInlineExpression(value);
  }

  public Optional<Object> getVariable(String name) {
    Object value = variables.get(name);
    if (value instanceof String && hasExpressions((String) value)) {
      return Optional.of(evaluate((String) value));
    }
    return Optional.ofNullable(value);
  }

  public Optional<String> getEnvironment(String name) {
    return Optional.ofNullable(environment.get(name));
  }

  public void setVariable(String name, Object value) {
    variables.put(name, value);
  }

  public void updateContext(Map<String, Object> item, StateDefinition state, ToolDefinition tool) {
    this.currentItem = item;
    this.currentState = state;
    this.currentTool = tool;
  }

  public void updateItem(Map<String, Object> item, int index) {
    this.currentItem = item;
    this.currentIndex = index;
  }

  public void updateRetryAttempt(int attempt) {
    this.retryAttempt = attempt;
  }

  public void updateAggregation(int index, String text) {
    this.aggregationIndex = index;
    this.aggregationText = text;
  }

  private String getTextContent() {
    if (currentItem == null) {
      return "";
    }

    Object content = currentItem.get("content");
    if (content instanceof String) {
      return (String) content;
    }

    for (String field : new String[] {"text", "body", "data"}) {
      Object value = currentItem.get(field);
      if (value instanceof String) {
        return (String) value;
      }
    }

    return "";
  }

  private int calculateTextLength() {
    return getTextContent().length();
  }

  private int calculateTextWords() {
    String text = getTextContent();
    if (text.trim().isEmpty()) {
      return 0;
    }
    return text.split("\\s+").length;
  }

  private int calculateTextTokens() {
    return (int) Math.ceil(getTextContent().length() / 4.0);
  }

  public EnhancedExecutionContext createChildContext() {
    return toBuilder().variables(Map.copyOf(variables)).build();
  }
}
