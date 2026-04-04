package machinum.definition;

import java.time.Duration;
import java.util.Map;
import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.compiler.CompiledSecret;
import machinum.definition.PipelineDefinition.FallbackDefinition;

@Builder
public record RootDefinition(
    String version,
    String type,
    String name,
    String description,
    Map<String, String> labels,
    Map<String, String> metadata,
    RootBodyDefinition body)
    implements Definition {

  @Builder
  public record RootBodyDefinition(
      CompiledMap<String> variables,
      RootExecutionDefinition execution,
      FallbackDefinition fallback,
      PipelineConfigDefinition config,
      RootCleanupDefinition cleanup,
      CompiledSecret secrets)
      implements BodyDefinition {}

  @Builder
  public record RootExecutionDefinition(
      Compiled<Boolean> parallel, Compiled<Integer> maxConcurrency) {}

  @Builder
  public record RootCleanupDefinition(
      Compiled<Duration> pass,
      Compiled<Duration> fail,
      Compiled<Integer> successRuns,
      Compiled<Integer> failedRuns) {}
}
