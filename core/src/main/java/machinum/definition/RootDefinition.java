package machinum.definition;

import java.util.Map;
import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.compiler.CompiledSecret;
import machinum.definition.PipelineDefinition.ErrorHandlingDefinition;

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
  public record RootBodyDefinition(
      CompiledMap variables,
      RootExecutionDefinition execution,
      ErrorHandlingDefinition errorHandling,
      PipelineConfigDefinition config,
      RootCleanupDefinition cleanup,
      CompiledSecret secrets)
      implements BodyDefinition {}

  @Builder
  public record RootExecutionDefinition(
      Compiled<Boolean> parallel,
      Compiled<Integer> maxConcurrency,
      Compiled<Boolean> manifestSnapshotEnabled,
      Compiled<String> manifestSnapshotMode) {}

  @Builder
  public record RootCleanupDefinition(
      Compiled<String> success,
      Compiled<String> failed,
      Compiled<String> successRuns,
      Compiled<String> failedRuns) {}
}
