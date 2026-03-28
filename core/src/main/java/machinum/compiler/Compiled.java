package machinum.compiler;

import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@FunctionalInterface
public interface Compiled<T> {

  T get();

  static Compiled<String> of(String raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw.contains("{{")) {
      return CompiledValue.of(raw, context, resolver);
    } else {
      return CompiledConstant.of(raw.trim());
    }
  }
}
