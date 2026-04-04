package machinum.definition;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.manifest.ItemsManifest;
import machinum.manifest.PipelineBody;

@Builder
//TODO: Add support of `snapshot`
public record PipelineDefinition(
    String version,
    String type,
    String name,
    String description,
    @Singular Map<String, String> labels,
    @Singular("metadata") Map<String, String> metadata,
    PipelineBodyDefinition body)
    implements Definition {

  @Builder
  public record PipelineBodyDefinition(
      CompiledMap<String> variables,
      PipelineConfigDefinition pipelineConfig,
      SourceDefinition source,
      ItemsDefinition items,
      @Singular List<PipelineStateDefinition> states,
      @Singular List<PipelineStateDefinition.PipelineToolDefinition> tools,
      FallbackDefinition fallback)
      implements BodyDefinition {}

  @Builder
  public record ItemsDefinition(
      Compiled<ItemsManifest.Type> type,
      Compiled<String> path,
      Compiled<String> customExtractor,
      CompiledMap<String> variables) {

    // TODO: redo items to uri format, like source
    public boolean isEmpty() {
      return Boolean.FALSE;
    }
  }

  @Builder
  public record SourceDefinition(Compiled<String> uri, CompiledMap<String> variables) {

    public boolean isEmpty() {
      return Objects.equals(uri().get(), "void://");
    }
  }

  @Builder
  public record FallbackDefinition(
      RetryDefinition retryConfig,
      @Singular List<ErrorStrategyDefinition> strategies) {}

  @Builder
  public record ErrorStrategyDefinition(
      Compiled<String> exception, Compiled<PipelineBody.ErrorStrategy> strategy) {}
}
