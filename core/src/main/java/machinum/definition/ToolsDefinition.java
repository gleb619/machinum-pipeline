package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;

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
      Compiled<String> registry,
      @Singular("bootstrap") List<BootstrapToolDefinition> bootstrap,
      @Singular List<ToolDefinition> tools)
      implements BodyDefinition {}

  @Builder
  public record BootstrapToolDefinition(
      Compiled<String> name, Compiled<String> description, CompiledMap config) {}
}
