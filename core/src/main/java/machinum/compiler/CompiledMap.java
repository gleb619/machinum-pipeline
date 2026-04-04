package machinum.compiler;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import lombok.Data;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@Data
@SuppressWarnings("unchecked")
public class CompiledMap<T> implements Compiled<Map<String, Compiled<T>>> {

  protected final Map<String, Compiled<Object>> compiledValues;

  public CompiledMap(Map<String, Compiled<T>> compiledValues) {
    this.compiledValues = new LinkedHashMap<>((Map) compiledValues);
  }

  public static <U> CompiledMap<U> empty() {
    return new CompiledMap<>(Collections.emptyMap());
  }

  public static <U> CompiledMap<U> of(
      Map<String, U> raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw == null || raw.isEmpty()) {
      return new CompiledMap<>(Collections.emptyMap());
    }

    var compiled = new LinkedHashMap<String, Compiled<U>>();

    for (Map.Entry<String, U> entry : raw.entrySet()) {
      var value = entry.getValue();
      var compiledValue = switch (value) {
        case String s -> Compiled.of(s, context, resolver);
        case Map map -> CompiledMap.of(map, context, resolver);
        case List list -> CompiledList.of(list, context, resolver);
        case null, default -> CompiledConstant.of(value);
      };

      compiled.put(entry.getKey(), compiledValue);
    }

    return new CompiledMap(compiled);
  }

  public Optional<T> get(String key) {
    var value = compiledValues.get(key);
    return value != null ? Optional.ofNullable((T) value.get()) : Optional.empty();
  }

  @Override
  public Map<String, Compiled<T>> get() {
    return new LinkedHashMap<>((Map) compiledValues);
  }

  public Map<String, T> asMap() {
    var result = new LinkedHashMap<String, T>();
    for (var entry : compiledValues.entrySet()) {
      result.put(entry.getKey(), (T) entry.getValue().get());
    }
    return result;
  }
}
