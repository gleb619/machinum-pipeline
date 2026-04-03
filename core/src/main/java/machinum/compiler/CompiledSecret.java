package machinum.compiler;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

public final class CompiledSecret {

  private final Map<String, Compiled<String>> internal;

  private CompiledSecret(Map<String, Compiled<String>> internal) {
    this.internal = internal;
  }

  public static CompiledSecret empty() {
    return new CompiledSecret(Collections.emptyMap());
  }

  public static CompiledSecret of(
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

  public String get(String key) {
    Compiled<String> val = internal.get(key);
    return val != null ? val.get() : null;
  }

  public boolean isEmpty() {
    return internal.isEmpty();
  }

  public Map<String, String> asMap() {
    Map<String, String> result = new LinkedHashMap<>();
    for (Map.Entry<String, Compiled<String>> entry : internal.entrySet()) {
      result.put(entry.getKey(), entry.getValue().get());
    }
    return result;
  }

  @Override
  public String toString() {
    return "CompiledSecret{size=" + internal.size() + "}";
  }
}
