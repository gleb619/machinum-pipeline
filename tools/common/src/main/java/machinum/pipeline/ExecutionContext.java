package machinum.pipeline;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;

@Data
@AllArgsConstructor
@Builder(toBuilder = true)
public class ExecutionContext {

  private final String runId;

  @Builder.Default
  private Map<String, Object> variables = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, Object> metadata = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, String> environment = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, Object> currentItem = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, Object> currentState = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, Object> currentTool = new ConcurrentHashMap<>();

  @Builder.Default
  private int currentIndex = 0;

  @Builder.Default
  private int retryAttempt = 0;

  @Builder.Default
  private int aggregationIndex = 0;

  private String aggregationText;

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Optional<Object> getVariable(String name) {
    return Optional.ofNullable(variables.get(name));
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Optional<String> getEnvironment(String name) {
    return Optional.ofNullable(environment.get(name));
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public void setVariable(String name, Object value) {
    variables.put(name, value);
  }

  public void updateContext(
      Map<String, Object> item, Map<String, Object> state, Map<String, Object> tool) {
    this.currentItem = item != null ? item : new ConcurrentHashMap<>();
    this.currentState = state != null ? state : new ConcurrentHashMap<>();
    this.currentTool = tool != null ? tool : new ConcurrentHashMap<>();
  }

  public void updateItem(Map<String, Object> item, int index) {
    this.currentItem = item != null ? item : new ConcurrentHashMap<>();
    this.currentIndex = index;
  }

  public void updateRetryAttempt(int attempt) {
    this.retryAttempt = attempt;
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public void updateAggregation(int index, String text) {
    this.aggregationIndex = index;
    this.aggregationText = text;
  }

  public Object get(String name, Object defaultValue) {
    return variables.getOrDefault(name, defaultValue);
  }

  public Optional<Object> get(String name) {
    return Optional.ofNullable(variables.get(name));
  }

  public Map<String, Object> getAll() {
    return new HashMap<>(variables);
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public boolean hasVariable(String name) {
    return variables.containsKey(name);
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public ExecutionContext createChildContext() {
    return toBuilder().variables(new ConcurrentHashMap<>(variables)).build();
  }

  private String getTextContent() {
    if (currentItem == null || currentItem.isEmpty()) {
      return "";
    }

    Object content = currentItem.get("content");
    if (content instanceof String) {
      return (String) content;
    }

    for (String field : new String[] {"text", "body", "data"}) {
      Object value = currentItem.get(field);
      if (value instanceof String) {
        return (String) value;
      }
    }

    return "";
  }

  public int getTextLength() {
    return getTextContent().length();
  }

  public int getTextWords() {
    String text = getTextContent();
    if (text.trim().isEmpty()) {
      return 0;
    }
    return text.split("\\s+").length;
  }

  public int getTextTokens() {
    return (int) Math.ceil(getTextContent().length() / 4.0);
  }
}
