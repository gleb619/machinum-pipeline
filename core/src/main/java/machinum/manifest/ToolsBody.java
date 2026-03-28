package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ToolsBody(
    @JsonAlias("tool-registry") ToolRegistryManifest toolRegistry,
    @JsonAlias("execution-targets") ExecutionTargetsManifest executionTargets,
    @Singular List<ToolsStateDefinitionManifest> states)
    implements ManifestBody {

  @Builder
  public record ToolRegistryManifest(String type, String url, String refresh) {}

  @Builder
  public record ExecutionTargetsManifest(
      String defaultTarget, @Singular List<ExecutionTargetManifest> targets) {}

  @Builder
  public record ExecutionTargetManifest(
      String name,
      String type,
      @JsonAlias("remote-host") String remoteHost,
      @JsonAlias("docker-host") String dockerHost) {}

  @Builder
  public record ToolsStateDefinitionManifest(
      String name,
      String description,
      String condition,
      @JsonAlias("tools") @Singular List<ToolDefinitionManifest> stateTools) {}

  @Builder
  public record ToolDefinitionManifest(
      String name,
      String type,
      String version,
      @JsonAlias("execution-target") String executionTarget,
      ToolSourceManifest source,
      ToolCacheManifest cache,
      String timeout,
      ToolConfigManifest config) {}

  @Builder
  public record ToolSourceManifest(
      String type,
      String url,
      @JsonAlias("git-tag") String gitTag,
      @JsonAlias("spi-class") String spiClass,
      String image) {}

  @Builder
  public record ToolCacheManifest(Boolean enabled, String key, String ttl) {}

  @Builder
  public record ToolConfigManifest(
      String model,
      Double temperature,
      @JsonAlias("input-schema") Map<String, Object> inputSchema,
      @JsonAlias("output-schema") Map<String, Object> outputSchema,
      List<String> args,
      String endpoint,
      String channel,
      @JsonAlias("work-dir") String workDir) {}
}
