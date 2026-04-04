package machinum.compiler;

import java.util.List;
import java.util.Map;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@FunctionalInterface
public interface Compiled<T> {

  T get();

  @SuppressWarnings("unchecked")
  static <U> Compiled<U> of(Object raw, ExpressionContext context, ExpressionResolver resolver) {
    return (Compiled<U>)
        switch (raw) {
          case String s -> ofString(s, context, resolver);
          case Map map -> CompiledMap.of(map, context, resolver);
          case List list -> CompiledList.of(list, context, resolver);
          case null -> CompiledConstant.of(null);
          default -> CompiledConstant.of(raw);
        };
  }

  static Compiled<String> ofString(
      String raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw.contains("{{")) {
      return CompiledValue.of(raw, context, resolver);
    } else {
      return CompiledConstant.of(raw.trim());
    }
  }
}
