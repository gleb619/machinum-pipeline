package machinum.compiler;

import lombok.Builder;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@Builder
public record CompiledValue<T>(
    String expression, ExpressionContext context, ExpressionResolver resolver)
    implements Compiled<T> {

  public static Compiled<String> of(
      String raw, ExpressionContext context, ExpressionResolver resolver) {
    return CompiledValue.<String>builder()
        .expression(raw.trim())
        .context(context)
        .resolver(resolver)
        .build();
  }

  @Override
  @SuppressWarnings("unchecked")
  public T get() {
    if (resolver == null || context == null) {
      throw new IllegalStateException("Can't execute expression");
    }

    return (T) resolver.resolveTemplate(expression, context);
  }
}
