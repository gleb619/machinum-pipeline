package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.ToolsBody.ToolRegistryType;

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
  public record ToolsBodyDefinition(
      ToolRegistryDefinition toolRegistry,
      @Singular("bootstrap") List<String> bootstrap,
      @Singular List<ToolDefinition> tools)
      implements BodyDefinition {}

  @Builder
  public record ToolRegistryDefinition(ToolRegistryType type, String url, String refresh) {}
}
