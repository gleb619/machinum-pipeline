package machinum.pipeline;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;

/**
 * Runtime key-value map used for expression resolution, variable substitution, and condition
 * evaluation during pipeline execution.
 */
@AllArgsConstructor
@Builder(toBuilder = true)
public class ExecutionContext {

  @Builder.Default
  private Map<String, Object> variables = new ConcurrentHashMap<>();

  /** Gets a variable value by name. */
  public Optional<Object> get(String name) {
    return Optional.ofNullable(variables.get(name));
  }

  /** Gets a variable value by name with a default fallback. */
  public Object get(String name, Object defaultValue) {
    return variables.getOrDefault(name, defaultValue);
  }

  /** Sets a variable value. */
  public void set(String name, Object value) {
    variables.put(name, value);
  }

  /** Sets all variables from the given map. */
  // TODO: Unused
  @Deprecated(forRemoval = true)
  public void setAll(Map<String, Object> vars) {
    variables.putAll(vars);
  }

  /** Returns all variables. */
  // TODO: Unused
  @Deprecated(forRemoval = true)
  public Map<String, Object> getAll() {
    return new HashMap<>(variables);
  }

  /** Returns true if the itemContext contains a variable with the given name. */
  // TODO: Unused
  @Deprecated(forRemoval = true)
  public boolean contains(String name) {
    return variables.containsKey(name);
  }

  /** Creates a copy of this execution itemContext. */
  // TODO: Unused
  @Deprecated(forRemoval = true)
  public ExecutionContext copy() {
    return toBuilder().build();
  }
}
