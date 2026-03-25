package machinum.expression;

import groovy.lang.Binding;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.script.ScriptEngineManager;
import javax.script.ScriptException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Default implementation of ExpressionResolver that supports template expressions with {{...}}
 * syntax. Integrates with Groovy scripting engine for complex expressions.
 */
@Slf4j
@RequiredArgsConstructor
public class DefaultExpressionResolver implements ExpressionResolver {

  private static final Pattern EXPRESSION_PATTERN = Pattern.compile("\\{\\{([^}]+)\\}\\}");
  private final ScriptEngineManager engineManager;

  @Override
  public Object resolveTemplate(String template, ExpressionContext context) {
    if (template == null || template.trim().isEmpty()) {
      return template;
    }

    if (!supportsInlineExpression(template)) {
      return template;
    }

    Matcher matcher = EXPRESSION_PATTERN.matcher(template);
    StringBuilder result = new StringBuilder();

    while (matcher.find()) {
      String expression = matcher.group(1).trim();
      Object resolvedValue = resolveExpression(expression, context);
      matcher.appendReplacement(result, Matcher.quoteReplacement(String.valueOf(resolvedValue)));
    }

    matcher.appendTail(result);
    return result.toString();
  }

  @Override
  public boolean supportsInlineExpression(String value) {
    return value != null && EXPRESSION_PATTERN.matcher(value).find();
  }

  /**
   * Resolves a single expression (without the {{ }} delimiters).
   *
   * @param expression the expression to resolve
   * @param context the expression context
   * @return the resolved value
   */
  private Object resolveExpression(String expression, ExpressionContext context) {
    try {
      // Create Groovy binding with all context variables
      var binding = new Binding();

      // Core context variables
      binding.setVariable("item", context.getItem());
      binding.setVariable("text", context.getText());
      binding.setVariable("index", context.getIndex());
      binding.setVariable("textLength", context.getTextLength());
      binding.setVariable("textWords", context.getTextWords());
      binding.setVariable("textTokens", context.getTextTokens());
      binding.setVariable("aggregationIndex", context.getAggregationIndex());
      binding.setVariable("aggregationText", context.getAggregationText());
      binding.setVariable("runId", context.getRunId());
      binding.setVariable("state", context.getState());
      binding.setVariable("tool", context.getTool());
      binding.setVariable("retryAttempt", context.getRetryAttempt());

      // Environment variables with env. prefix access
      binding.setVariable("env", context.getEnv());

      // Pipeline variables
      binding.setVariable("variables", context.getVariables());

      // Script registry for script calls
      binding.setVariable("scripts", context.getScripts());

      // Create a new Groovy engine with the binding
      var groovy = engineManager.getEngineByName("groovy");
      // Fallback to standard evaluation using put() method
      groovy.put("item", context.getItem());
      groovy.put("text", context.getText());
      groovy.put("index", context.getIndex());
      groovy.put("textLength", context.getTextLength());
      groovy.put("textWords", context.getTextWords());
      groovy.put("textTokens", context.getTextTokens());
      groovy.put("aggregationIndex", context.getAggregationIndex());
      groovy.put("aggregationText", context.getAggregationText());
      groovy.put("runId", context.getRunId());
      groovy.put("state", context.getState());
      groovy.put("tool", context.getTool());
      groovy.put("retryAttempt", context.getRetryAttempt());
      groovy.put("env", context.getEnv());
      groovy.put("variables", context.getVariables());
      groovy.put("scripts", context.getScripts());
      return groovy.eval(expression);

    } catch (ScriptException e) {
      log.error("Failed to resolve expression: {}", expression, e);
      throw new RuntimeException("Expression resolution failed for: " + expression, e);
    }
  }

  /**
   * Resolves a simple property path (e.g., "item.id", "metadata.title"). This is used for simple
   * property access without full Groovy evaluation.
   *
   * @param path the property path
   * @param context the expression context
   * @return the resolved value or null if not found
   */
  // TODO: remove unused
  @Deprecated(forRemoval = true)
  private Object resolvePropertyPath(String path, ExpressionContext context) {
    String[] parts = path.split("\\.");
    if (parts.length == 0) {
      return null;
    }

    Object current = getRootObject(parts[0], context);
    if (current == null) {
      return null;
    }

    // Navigate through the property path
    for (int i = 1; i < parts.length; i++) {
      if (current instanceof Map) {
        current = ((Map<?, ?>) current).get(parts[i]);
      } else {
        // Try reflection for object properties
        try {
          var getter = current.getClass().getMethod("get" + capitalize(parts[i]));
          current = getter.invoke(current);
        } catch (Exception e) {
          log.debug(
              "Could not access property {} on object {}",
              parts[i],
              current.getClass().getSimpleName());
          return null;
        }
      }

      if (current == null) {
        return null;
      }
    }

    return current;
  }

  /** Gets the root object for a property name. */
  private Object getRootObject(String rootName, ExpressionContext context) {
    return switch (rootName) {
      case "item" -> context.getItem();
      case "text" -> context.getText();
      case "index" -> context.getIndex();
      case "textLength" -> context.getTextLength();
      case "textWords" -> context.getTextWords();
      case "textTokens" -> context.getTextTokens();
      case "aggregationIndex" -> context.getAggregationIndex();
      case "aggregationText" -> context.getAggregationText();
      case "runId" -> context.getRunId();
      case "state" -> context.getState();
      case "tool" -> context.getTool();
      case "retryAttempt" -> context.getRetryAttempt();
      case "env" -> context.getEnv();
      case "variables" -> context.getVariables();
      case "scripts" -> context.getScripts();
      default -> context.getVariables().get(rootName);
    };
  }

  /** Capitalizes the first letter of a string. */
  private String capitalize(String str) {
    if (str == null || str.isEmpty()) {
      return str;
    }
    return str.substring(0, 1).toUpperCase() + str.substring(1);
  }
}
