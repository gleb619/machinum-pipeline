package machinum.pipeline;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import machinum.streamer.StreamItem;

/**
 * Execution context passed through the pipeline during tool execution.
 *
 * <p>Holds the current {@link StreamItem}, variables, environment, and text analysis helpers. The
 * currentItem flows through states and is updated by the executor per item batch.
 *
 * @see <a href="https://docs/technical-design.md#32-core-interfaces">Technical Design §3.2 Core
 *     Interfaces</a>
 * @see <a href="https://docs/technical-design.md#62-available-bindings">Technical Design §6.2
 *     Available Bindings</a>
 * @see <a href="https://docs/core-architecture.md#3-checkpointing--state-management">Core
 *     Architecture §3 Checkpointing & State Management</a>
 */
@Data
@AllArgsConstructor
@Builder(toBuilder = true)
public class ExecutionContext {

  private final String runId;

  private Path workspaceRoot;

  @Builder.Default
  private Map<String, String> variables = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, String> environment = new ConcurrentHashMap<>();

  private StreamItem currentItem;

  @Builder.Default
  private Map<String, Object> currentState = new ConcurrentHashMap<>();

  @Builder.Default
  private int currentIndex = 0;

  @Builder.Default
  private int retryAttempt = 0;

  @Builder.Default
  private int aggregationIndex = 0;

  private String aggregationText;

  /** Update the current item being processed. Called by the executor when streaming a new batch. */
  public void updateItem(StreamItem item) {
    this.currentItem = item;
    this.currentIndex = item != null && item.index() != null ? item.index() : 0;
  }

  /** Update the retry attempt counter before retrying a failed tool. */
  public void updateRetryAttempt(int attempt) {
    this.retryAttempt = attempt;
  }

  public String get(String name, String defaultValue) {
    return variables.getOrDefault(name, defaultValue);
  }

  public Optional<Object> get(String name) {
    return Optional.ofNullable(variables.get(name));
  }

  public Map<String, Object> getAll() {
    return new HashMap<>(variables);
  }

  public String getTextContent() {
    return currentItem != null && currentItem.content() != null ? currentItem.content() : "";
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
