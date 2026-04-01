package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.tool.RegistryManifest;

@Builder
public record ToolsBody(
    ToolRegistryConfigManifest registry,
    @Singular("bootstrap") List<ToolManifest> bootstrap,
    @Singular List<ToolManifest> tools)
    implements ManifestBody {

  @Builder
  public record ToolRegistryConfigManifest(ToolRegistryType type, String url, String refresh) {}

  @Builder
  public record ToolManifest(
      String name,
      String description,
      String type,
      @JsonAlias("execution-target") String executionTarget,
      ToolConfigManifest config) {}

  @Builder
  public record ToolConfigManifest(
      @JsonAlias("input-schema") Map<String, Object> inputSchema,
      @JsonAlias("output-schema") Map<String, Object> outputSchema,
      @JsonAnySetter Map<String, Object> params) {}

  public enum ToolRegistryType {
    file,
    http,
    builtin,
  }

  //TODO: Remove
  @Deprecated(forRemoval = true)
  public RegistryManifest toRegistryManifest() {
    if (tools == null || tools.isEmpty()) {
      return new RegistryManifest("registry", "1.0.0", List.of());
    }

    var jars = tools.stream()
        .map(tool -> new RegistryManifest.ToolJarInfo(
            tool.name(),
            "classpath",
            tool.type() != null ? tool.type() : tool.name(),
            List.of(),
            null))
        .toList();

    return new RegistryManifest("registry", "1.0.0", jars);
  }
}
