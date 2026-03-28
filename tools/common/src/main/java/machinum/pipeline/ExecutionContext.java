package machinum.pipeline;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;

@AllArgsConstructor
@Builder(toBuilder = true)
public class ExecutionContext {

  @Builder.Default
  private Map<String, Object> variables = new ConcurrentHashMap<>();

  public Optional<Object> get(String name) {
    return Optional.ofNullable(variables.get(name));
  }

  public Object get(String name, Object defaultValue) {
    return variables.getOrDefault(name, defaultValue);
  }

  public void set(String name, Object value) {
    variables.put(name, value);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public void setAll(Map<String, Object> vars) {
    variables.putAll(vars);
  }

  public Map<String, Object> getAll() {
    return new HashMap<>(variables);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public boolean contains(String name) {
    return variables.containsKey(name);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public ExecutionContext copy() {
    return toBuilder().build();
  }
}
