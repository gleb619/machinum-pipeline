package machinum.tool;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record RegistryManifest(
    String version,
    String type,
    String name,
    String description,
    @Singular Map<String, Object> labels,
    Map<String, Object> metadata,
    RegistryManifestBody body) {

  @Builder
  public record RegistryManifestBody(@Singular List<ToolJarInfo> jars) {

    public static RegistryManifestBody empty() {
      return RegistryManifestBody.builder().build();
    }
  }

  @Builder
  public record ToolJarInfo(
      String toolName,
      String jarPath,
      String className,
      @Singular List<String> dependencies,
      String signature) {}
}
