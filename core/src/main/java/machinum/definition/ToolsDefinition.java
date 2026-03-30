package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

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
      ExecutionTargetsDefinition executionTargets,
      @Singular List<ToolDefinition> tools)
      implements BodyDefinition {}

  @Builder
  public record ToolRegistryDefinition(String type, String url, String refresh) {}

  @Builder
  public record ExecutionTargetsDefinition(
      String defaultTarget, @Singular List<ExecutionTargetDefinition> targets) {}

  @Builder
  public record ExecutionTargetDefinition(
      String name, String type, String remoteHost, String dockerHost) {}
}
