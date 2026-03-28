package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import machinum.compiler.CompiledMap;

@Builder
public record PipelineDefinition(
    String version,
    String type,
    String name,
    String description,
    Map<String, Object> labels,
    Map<String, Object> metadata,
    PipelineBodyDefinition body)
    implements Definition {

  @Builder
  public record PipelineBodyDefinition(
      CompiledMap variables,
      PipelineConfigDefinition pipelineConfig,
      SourceDefinition source,
      ItemsDefinition items,
      List<PipelineStateDefinition> states,
      ErrorHandlingDefinition errorHandling)
      implements BodyDefinition {}
}
