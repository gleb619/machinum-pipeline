package machinum.executor;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;
import lombok.RequiredArgsConstructor;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.manifest.ManifestObject;
import machinum.manifest.ManifestObject.Type;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;
import org.yaml.snakeyaml.Yaml;
import tools.jackson.databind.ObjectMapper;

@Slf4j
@RequiredArgsConstructor
public class YamlManifestLoader {

  private final ObjectMapper objectMapper;
  private final Yaml yaml;

  public Optional<RootManifest> loadRootManifest(Path workspaceDir) {
    Path manifestPath = findRootManifest(workspaceDir);
    if (manifestPath == null) {
      return Optional.empty();
    }
    return Optional.ofNullable(readManifest(manifestPath, RootManifest.class, "Root manifest"));
  }

  public Optional<ToolsManifest> loadToolsManifest(Path workspaceDir) {
    Path manifestPath = findToolsManifest(workspaceDir);
    if (manifestPath == null) {
      return Optional.empty();
    }
    return Optional.ofNullable(readManifest(manifestPath, ToolsManifest.class, "Tools manifest"));
  }

  public Optional<PipelineManifest> loadPipelineManifest(Path workspaceDir, String pipelineName) {
    Path manifestPath = findPipelineManifest(workspaceDir, pipelineName);
    if (manifestPath == null) {
      return Optional.empty();
    }
    return Optional.ofNullable(
        readManifest(manifestPath, PipelineManifest.class, "Pipeline manifest"));
  }

  public List<PipelineManifest> loadPipelineManifest(Path workspaceDir) {
    List<Path> manifestPaths = findPipelineManifest(workspaceDir);
    if (manifestPaths == null || manifestPaths.isEmpty()) {
      return Collections.emptyList();
    }

    return manifestPaths.stream()
        .map(
            manifestPath -> readManifest(manifestPath, PipelineManifest.class, "Pipeline manifest"))
        .toList();
  }

  @SneakyThrows
  private <T> T readManifest(Path path, Class<T> manifestClass, String manifestDescription) {
    try (InputStream is = Files.newInputStream(path.normalize())) {
      Map<String, Object> raw = yaml.load(is);
      if (raw == null) {
        throw new ValidationException(manifestDescription + " is empty: " + path);
      }
      return objectMapper.convertValue(raw, manifestClass);
    }
  }

  private Path findRootManifest(Path workspaceDir) {
    // First check for seed.yaml in root
    Path seedPath = workspaceDir.resolve("seed.yaml");
    if (Files.exists(seedPath)) {
      return seedPath;
    }

    // Fallback: scan for any root manifest
    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.root)
        .map(ManifestObject::filepath)
        .findFirst()
        .orElse(null);
  }

  private Path findToolsManifest(Path workspaceDir) {
    // First check for .mt/tools.yaml
    Path toolsPath = workspaceDir.resolve(".mt/tools.yaml");
    if (Files.exists(toolsPath)) {
      return toolsPath;
    }

    // Fallback: scan for any tools manifest
    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.tools)
        .map(ManifestObject::filepath)
        .findFirst()
        .orElse(null);
  }

  private Path findPipelineManifest(Path workspaceDir, String pipelineName) {
    // First check in standard location
    Path manifestsDir = workspaceDir.resolve("src/main/manifests");
    if (Files.isDirectory(manifestsDir)) {
      Path namedPath = manifestsDir.resolve(pipelineName + ".yaml");
      if (Files.exists(namedPath)) {
        return namedPath;
      }
    }

    // Fallback: scan for matching pipeline manifest
    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.pipeline)
        .map(ManifestObject::filepath)
        .filter(path -> {
          // TODO: replace with regex check
          PipelineManifest manifest =
              readManifest(path, PipelineManifest.class, "Pipeline manifest");
          return pipelineName.equals(manifest.name());
        })
        .findFirst()
        .orElse(null);
  }

  private List<Path> findPipelineManifest(Path workspaceDir) {
    // Fallback: scan for matching pipeline manifest
    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.pipeline)
        .map(ManifestObject::filepath)
        .toList();
  }

  @SneakyThrows
  private List<ManifestObject> scanManifests(Path workspaceDir) {
    if (!Files.isDirectory(workspaceDir)) {
      throw new IllegalArgumentException("Workspace directory does not exist: " + workspaceDir);
    }

    List<ManifestObject> manifests = new ArrayList<>();

    try (Stream<Path> paths = Files.walk(workspaceDir)) {
      paths
          .filter(Files::isRegularFile)
          .filter(path -> path.toString().endsWith(".yaml") || path.toString().endsWith(".yml"))
          .filter(path ->
              !path.toString().contains("/.git/") && !path.toString().contains("/.history/"))
          .forEach(path -> {
            Type type = detectManifestType(path);
            if (type != Type.unknown) {
              manifests.add(new ManifestObject(path, type));
              log.trace("Discovered {} manifest: {}", type, path);
            }
          });
    }

    return manifests;
  }

  @SuppressWarnings("unchecked")
  private Type detectManifestType(Path path) {
    Type output;
    String typeRaw = "";

    try (InputStream is = Files.newInputStream(path)) {
      // TODO: replace with regex check
      Map<String, Object> raw = yaml.load(is);
      if (raw == null) {
        output = Type.unknown;
      }

      typeRaw = (String) raw.get("type");
      output = switch (typeRaw) {
        case "root" -> Type.root;
        case "tools" -> Type.tools;
        case "pipeline" -> Type.pipeline;
        default -> Type.unknown;
      };
    } catch (IOException e) {
      log.warn("Failed to detect manifest type for {}: {}", path, e.getMessage());
      output = Type.unknown;
    }

    if (output == Type.unknown) {
      throw new IllegalStateException("Unknown type of manifest found: " + typeRaw);
    }

    return output;
  }

  public static class ValidationException extends RuntimeException {

    public ValidationException(String message) {
      super(message);
    }
  }
}
