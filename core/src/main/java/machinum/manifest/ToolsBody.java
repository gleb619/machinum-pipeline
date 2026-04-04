package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.io.BootstrapToolManifestDeserializer;
import machinum.manifest.io.ToolManifestDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

@Builder
public record ToolsBody(
    String registry,

    @Singular("bootstrap") @JsonDeserialize(contentUsing = BootstrapToolManifestDeserializer.class)
    List<BootstrapToolManifest> bootstrap,

    @Singular @JsonDeserialize(contentUsing = ToolManifestDeserializer.class)
    List<ToolManifest> tools)
    implements ManifestBody {

  public static ToolsBody empty() {
    return ToolsBody.builder()
        .registry("classpath://default")
        .bootstrap(BootstrapToolManifest.builder().name("workspace").build())
        .tools(Collections.emptyList())
        .build();
  }

  @Builder
  @JsonDeserialize(using = BootstrapToolManifestDeserializer.class)
  public record BootstrapToolManifest(
      String name, String description, @Singular("configItem") Map<String, Object> config) {}

  @Builder
  @JsonDeserialize(using = ToolManifestDeserializer.class)
  public record ToolManifest(String name, String description, ToolConfigManifest config) {}

  @Builder
  public record ToolConfigManifest(
      @JsonAlias("input") @Singular("input") Map<String, Object> inputSchema,
      @JsonAlias("output") @Singular("output") Map<String, Object> outputSchema,
      @JsonAnySetter @Singular Map<String, Object> params) {

    public static ToolConfigManifest empty() {
      return ToolConfigManifest.builder()
          .build();
    }
  }

  public enum ToolRegistryType {
    file,
    http,
    builtin,
  }
}
