package machinum.tool;

import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
//TODO: Redo, add basic fields here. Read `docs/yaml-schema.md`, a `Common Base Structure`. Add RegistryManifest body
public record RegistryManifest(
    String type, String version, @Singular List<ToolJarInfo> jars) {

  @Builder
  public record ToolJarInfo(
      String toolName,
      String jarPath,
      String className,
      @Singular List<String> dependencies,
      String signature) {}
}
