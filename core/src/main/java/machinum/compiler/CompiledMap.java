package machinum.compiler;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@RequiredArgsConstructor
public class CompiledMap implements Supplier<Map<String, Object>> {

  private final Map<String, Compiled<Object>> compiledValues;

  public static CompiledMap of(
      Map<String, Object> raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw == null || raw.isEmpty()) {
      return new CompiledMap(Collections.emptyMap());
    }

    Map<String, Compiled<Object>> compiled = new LinkedHashMap<>();

    for (Map.Entry<String, Object> entry : raw.entrySet()) {
      Object value = entry.getValue();
      Compiled compiledValue;

      if (value instanceof String s) {
        compiledValue = Compiled.of(s, context, resolver);
      } else if (value instanceof Map) {
        throw new IllegalArgumentException("Not supported for now!");
      } else {
        throw new IllegalArgumentException("Not supported!");
      }

      compiled.put(entry.getKey(), compiledValue);
    }

    return new CompiledMap(compiled);
  }

  public Object get(String key) {
    Compiled<Object> value = compiledValues.get(key);
    return value != null ? value.get() : null;
  }

  @SuppressWarnings("unchecked")
  public <T> T get(String key, Class<T> type) {
    Object value = get(key);
    if (value == null) {
      return null;
    }
    if (type.isInstance(value)) {
      return (T) value;
    }
    throw new ClassCastException("Value for key '%s' is %s, expected %s"
        .formatted(key, value.getClass().getSimpleName(), type.getSimpleName()));
  }

  @Override
  public Map<String, Object> get() {
    Map<String, Object> result = new LinkedHashMap<>();
    for (Map.Entry<String, Compiled<Object>> entry : compiledValues.entrySet()) {
      result.put(entry.getKey(), entry.getValue().get());
    }
    return result;
  }
}
