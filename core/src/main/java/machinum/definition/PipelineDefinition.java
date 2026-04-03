package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.manifest.ItemsManifest;
import machinum.manifest.PipelineBody;
import machinum.manifest.SourceManifest;

@Builder
public record PipelineDefinition(
    String version,
    String type,
    String name,
    String description,
    @Singular Map<String, Object> labels,
    @Singular("metadata") Map<String, Object> metadata,
    PipelineBodyDefinition body)
    implements Definition {

  @Builder
  public record PipelineBodyDefinition(
      CompiledMap variables,
      PipelineConfigDefinition pipelineConfig,
      SourceDefinition source,
      ItemsDefinition items,
      @Singular List<PipelineStateDefinition> states,
      @Singular List<PipelineStateDefinition.PipelineToolDefinition> tools,
      ErrorHandlingDefinition errorHandling)
      implements BodyDefinition {}

  @Builder
  public record ItemsDefinition(
      Compiled<ItemsManifest.Type> type,
      Compiled<String> path,
      Compiled<String> customExtractor,
      CompiledMap variables) {}

  @Builder
  public record SourceDefinition(
      Compiled<SourceManifest.Type> type,
      Compiled<String> fileLocation,
      Compiled<SourceManifest.Format> format,
      Compiled<String> customLoader,
      CompiledMap variables) {}

  @Builder
  public record ErrorHandlingDefinition(
      Compiled<String> defaultStrategy,
      RetryDefinition retryConfig,
      @Singular List<ErrorStrategyDefinition> strategies) {}

  @Builder
  public record ErrorStrategyDefinition(
      Compiled<String> exception, Compiled<PipelineBody.ErrorStrategy> strategy) {}
}
