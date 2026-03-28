package machinum.definition;

import java.util.Map;
import lombok.Builder;
import machinum.compiler.CompiledMap;

@Builder
public record RootDefinition(
    String version,
    String type,
    String name,
    String description,
    Map<String, Object> labels,
    Map<String, Object> metadata,
    RootBodyDefinition body)
    implements Definition {

  @Builder
  public record RootBodyDefinition(CompiledMap pipelineConfig, CompiledMap env)
      implements BodyDefinition {}
}
