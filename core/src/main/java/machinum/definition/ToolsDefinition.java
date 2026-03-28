package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;

@Builder
public record ToolsDefinition(
    String version,
    String type,
    String name,
    String description,
    Map<String, Object> labels,
    Map<String, Object> metadata,
    ToolsBodyDefinition body)
    implements Definition {

  @Builder
  public record ToolsBodyDefinition(List<ToolDefinition> tools) implements BodyDefinition {}
}
