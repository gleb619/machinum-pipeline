package machinum.compiler;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

public final class CompiledSecret extends CompiledMap<String> {

  private CompiledSecret(Map<String, Compiled<String>> compiledValues) {
    super(compiledValues);
  }

  public static CompiledSecret empty() {
    return new CompiledSecret(Collections.emptyMap());
  }

  public static CompiledSecret from(
      Map<String, String> raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw == null || raw.isEmpty()) {
      return new CompiledSecret(Collections.emptyMap());
    }

    Map<String, Compiled<String>> map = new LinkedHashMap<>();
    for (var entry : raw.entrySet()) {
      map.put(entry.getKey(), Compiled.of(entry.getValue(), context, resolver));
    }
    return new CompiledSecret(Collections.unmodifiableMap(map));
  }

  @Override
  public String toString() {
    return "CompiledSecret{size=%d}".formatted(compiledValues.size());
  }
}
