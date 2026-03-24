package machinum.pipeline;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.Builder;
import lombok.RequiredArgsConstructor;

/**
 * Resolves expressions and variable substitutions in strings. Supports ${var.name} syntax for
 * variable interpolation.
 */
@RequiredArgsConstructor
//TODO: replace with groovy expression resolver
@Deprecated(forRemoval = true)
public class ExpressionResolver {

  private static final Pattern VARIABLE_PATTERN = Pattern.compile("\\$\\{([^}]+)}");

  private final ExecutionContext context;

  /**
   * Resolves all variable references in the given expression string. Unresolved variables are left
   * as-is.
   */
  public String resolve(String expression) {
    if (expression == null) {
      return null;
    }

    Matcher matcher = VARIABLE_PATTERN.matcher(expression);
    StringBuilder result = new StringBuilder();

    while (matcher.find()) {
      String varName = matcher.group(1);
      String replacement = context.get(varName).map(Object::toString).orElse(matcher.group(0));
      matcher.appendReplacement(result, Matcher.quoteReplacement(replacement));
    }
    matcher.appendTail(result);

    return result.toString();
  }

  /**
   * Evaluates a condition expression against the current itemContext. Supports simple equality and
   * boolean checks.
   */
  public boolean evaluateCondition(String condition) {
    if (condition == null || condition.isBlank()) {
      return true;
    }

    String resolved = resolve(condition);

    if ("true".equalsIgnoreCase(resolved)) {
      return true;
    }
    if ("false".equalsIgnoreCase(resolved)) {
      return false;
    }

    return !resolved.equals(condition);
  }
}
