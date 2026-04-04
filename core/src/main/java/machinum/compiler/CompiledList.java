package machinum.compiler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@Data
@RequiredArgsConstructor
public class CompiledList<T> implements Compiled<List<Compiled<T>>> {

  private final List<Compiled<Object>> compiledValues;

  public static CompiledList<Object> empty() {
    return new CompiledList<>(Collections.emptyList());
  }

  @SuppressWarnings("unchecked")
  public static CompiledList<Object> of(
      List<Object> raw, ExpressionContext context, ExpressionResolver resolver) {
    if (raw == null || raw.isEmpty()) {
      return new CompiledList<>(Collections.emptyList());
    }

    List<Compiled<Object>> compiled = new ArrayList<>();

    for (Object value : raw) {
      var compiledValue = switch (value) {
        case String s -> Compiled.of(s, context, resolver);
        case Map map -> CompiledMap.of(map, context, resolver);
        case List list -> CompiledList.of(list, context, resolver);
        case null, default -> CompiledConstant.of(value);
      };

      compiled.add(compiledValue);
    }

    return new CompiledList<>(compiled);
  }

  @SuppressWarnings("unchecked")
  public Optional<T> get(int index) {
    if (index < 0 || index >= compiledValues.size()) {
      return Optional.empty();
    }
    var value = compiledValues.get(index);
    return Optional.ofNullable((T) value.get());
  }

  @SuppressWarnings("unchecked")
  public <U> U get(int index, Class<U> type) {
    Object value = get(index).orElse(null);
    if (value == null) {
      return null;
    }
    if (type.isInstance(value)) {
      return (U) value;
    }
    throw new ClassCastException("Value at index %d is %s, expected %s"
        .formatted(index, value.getClass().getSimpleName(), type.getSimpleName()));
  }

  public int size() {
    return compiledValues.size();
  }

  public boolean isEmpty() {
    return compiledValues.isEmpty();
  }

  @Override
  public List<Compiled<T>> get() {
    return new ArrayList<>((List) compiledValues);
  }
}
