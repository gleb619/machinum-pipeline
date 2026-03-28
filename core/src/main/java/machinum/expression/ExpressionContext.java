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

@Data
@AllArgsConstructor
@Builder(toBuilder = true)
@NoArgsConstructor(access = AccessLevel.PUBLIC)
public class ExpressionContext {

  @Builder.Default
  private Map<String, Object> item = new ConcurrentHashMap<>();

  @Builder.Default
  private String text = "";

  @Builder.Default
  private int index = 0;

  @Builder.Default
  private int textLength = 0;

  @Builder.Default
  private int textWords = 0;

  @Builder.Default
  private int textTokens = 0;

  @Builder.Default
  private int aggregationIndex = 0;

  private String aggregationText;

  @Builder.Default
  private String runId = "";

  private StateDefinition state;

  private ToolDefinition tool;

  @Builder.Default
  private int retryAttempt = 0;

  @Builder.Default
  private Map<String, String> env = new ConcurrentHashMap<>();

  @Builder.Default
  private Map<String, Object> variables = new ConcurrentHashMap<>();

  private ScriptRegistry scripts;
}
