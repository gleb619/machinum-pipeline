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

/**
 * Enhanced execution context that integrates with expression resolution system. Provides runtime
 * context for pipeline execution with expression evaluation capabilities.
 */
@AllArgsConstructor
@Builder(toBuilder = true)
@Getter
public class EnhancedExecutionContext {

  /** Unique identifier for this pipeline run. */
  private final String runId;

  /** Pipeline metadata from root configuration. */
  private final Map<String, Object> metadata;

  /** Pipeline variables from configuration. */
  private final Map<String, Object> variables;

  /** Environment variables. */
  private final Map<String, String> environment;

  /** Expression resolver for template evaluation. */
  private final ExpressionResolver expressionResolver;

  /** Script registry for external script access. */
  private final ScriptRegistry scriptRegistry;

  /** Current item being processed. */
  private Map<String, Object> currentItem;

  /** Current state definition. */
  private StateDefinition currentState;

  /** Current tool definition. */
  private ToolDefinition currentTool;

  /** Current item index in collection. */
  private int currentIndex;

  /** Current retry attempt. */
  private int retryAttempt;

  /** Aggregation index for window operations. */
  private int aggregationIndex;

  /** Aggregation text for window operations. */
  private String aggregationText;

  /**
   * Evaluates a template expression with {{...}} syntax.
   *
   * @param template the template string to evaluate
   * @return the resolved value
   */
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

  /**
   * Checks if a value contains expressions that need resolution.
   *
   * @param value the value to check
   * @return true if the value contains {{...}} expressions
   */
  public boolean hasExpressions(String value) {
    return expressionResolver != null && expressionResolver.supportsInlineExpression(value);
  }

  /**
   * Gets a variable value with expression resolution.
   *
   * @param name the variable name
   * @return the resolved value
   */
  public Optional<Object> getVariable(String name) {
    Object value = variables.get(name);
    if (value instanceof String && hasExpressions((String) value)) {
      return Optional.of(evaluate((String) value));
    }
    return Optional.ofNullable(value);
  }

  /**
   * Gets an environment variable.
   *
   * @param name the environment variable name
   * @return the environment variable value
   */
  public Optional<String> getEnvironment(String name) {
    return Optional.ofNullable(environment.get(name));
  }

  /**
   * Sets a variable value.
   *
   * @param name the variable name
   * @param value the variable value
   */
  public void setVariable(String name, Object value) {
    variables.put(name, value);
  }

  /** Updates the current processing context. */
  public void updateContext(Map<String, Object> item, StateDefinition state, ToolDefinition tool) {
    this.currentItem = item;
    this.currentState = state;
    this.currentTool = tool;
  }

  /** Updates the current item and index. */
  public void updateItem(Map<String, Object> item, int index) {
    this.currentItem = item;
    this.currentIndex = index;
  }

  /** Updates retry attempt count. */
  public void updateRetryAttempt(int attempt) {
    this.retryAttempt = attempt;
  }

  /** Updates aggregation context. */
  public void updateAggregation(int index, String text) {
    this.aggregationIndex = index;
    this.aggregationText = text;
  }

  /** Gets text content from current item. */
  private String getTextContent() {
    if (currentItem == null) {
      return "";
    }

    Object content = currentItem.get("content");
    if (content instanceof String) {
      return (String) content;
    }

    // Try other common content fields
    for (String field : new String[] {"text", "body", "data"}) {
      Object value = currentItem.get(field);
      if (value instanceof String) {
        return (String) value;
      }
    }

    return "";
  }

  /** Calculates text length. */
  private int calculateTextLength() {
    return getTextContent().length();
  }

  /** Calculates word count. */
  private int calculateTextWords() {
    String text = getTextContent();
    if (text.trim().isEmpty()) {
      return 0;
    }
    return text.split("\\s+").length;
  }

  /** Calculates token count (approximation using CL100K_BASE). */
  private int calculateTextTokens() {
    // Simple approximation: ~4 characters per token for CL100K_BASE
    // In a real implementation, you'd use the actual tokenizer
    return (int) Math.ceil(getTextContent().length() / 4.0);
  }

  /**
   * Creates a child context with isolated variables.
   *
   * @return a new execution context with copied variables
   */
  public EnhancedExecutionContext createChildContext() {
    return toBuilder().variables(Map.copyOf(variables)).build();
  }
}
