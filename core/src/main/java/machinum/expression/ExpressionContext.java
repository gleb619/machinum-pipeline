package machinum.expression;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;

/**
 * Holds all variables available for expression resolution during pipeline execution.
 *
 * <p>Predefined variables (from TDD section 4.4):
 *
 * <ul>
 *   <li>{@code item} - Current source/items element (Map<String, Object>)
 *   <li>{@code text} - Content of current element
 *   <li>{@code index} - Element index in collection
 *   <li>{@code textLength} - Character count
 *   <li>{@code textWords} - Word count
 *   <li>{@code textTokens} - Token count via CL100K_BASE
 *   <li>{@code aggregationIndex} - Index for window/aggregation
 *   <li>{@code aggregationText} - Window/aggregation result
 *   <li>{@code runId} - Active run identifier
 *   <li>{@code state} - Current state descriptor
 *   <li>{@code tool} - Current tool descriptor
 *   <li>{@code retryAttempt} - Current retry number
 * </ul>
 */
@Data
@AllArgsConstructor
@Builder(toBuilder = true)
@NoArgsConstructor(access = AccessLevel.PUBLIC)
public class ExpressionContext {

  /** Current item being processed (Map representation). */
  @Builder.Default
  private Map<String, Object> item = new ConcurrentHashMap<>();

  /** Current text content. */
  @Builder.Default
  private String text = "";

  /** Element index in collection. */
  @Builder.Default
  private int index = 0;

  /** Character count of text. */
  @Builder.Default
  private int textLength = 0;

  /** Word count of text. */
  @Builder.Default
  private int textWords = 0;

  /** Token count of text (CL100K_BASE). */
  @Builder.Default
  private int textTokens = 0;

  /** Index for window/aggregation operations. */
  @Builder.Default
  private int aggregationIndex = 0;

  /** Result of window/aggregation operations. */
  private String aggregationText;

  /** Current run identifier. */
  @Builder.Default
  private String runId = "";

  /** Current state descriptor. */
  private StateDefinition state;

  /** Current tool descriptor. */
  private ToolDefinition tool;

  /** Current retry attempt number. */
  @Builder.Default
  private int retryAttempt = 0;

  /** Environment variables (accessible via env.VARIABLE_NAME). */
  @Builder.Default
  private Map<String, String> env = new ConcurrentHashMap<>();

  /** Pipeline variables (custom variables from pipeline config). */
  @Builder.Default
  private Map<String, Object> variables = new ConcurrentHashMap<>();

  /** Script registry for script-based expressions. */
  private ScriptRegistry scripts;
}
