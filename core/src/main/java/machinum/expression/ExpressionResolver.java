package machinum.expression;

public interface ExpressionResolver {

  Object resolveTemplate(String template, ExpressionContext context);

  boolean supportsInlineExpression(String value);
}
