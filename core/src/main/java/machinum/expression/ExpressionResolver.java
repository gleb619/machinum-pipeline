package machinum.expression;

/**
 * Resolves expressions in template strings. Supports {{expression}} syntax for dynamic value
 * resolution during pipeline execution.
 */
public interface ExpressionResolver {

  /**
   * Resolves all expressions in the given template string.
   *
   * @param template the template containing {{expression}} placeholders
   * @param context the expression context with variables and functions
   * @return the resolved value (may be String, Boolean, Number, or Object)
   */
  Object resolveTemplate(String template, ExpressionContext context);

  /**
   * Checks if a value contains inline expressions that need resolution.
   *
   * @param value the value to check
   * @return true if the value contains {{...}} expressions
   */
  boolean supportsInlineExpression(String value);
}
