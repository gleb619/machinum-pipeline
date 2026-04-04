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
// TODO: Refactor next, class, on load put data to metadata, fill it with file name, creation date,
// current date,
// timezone, language, etc, e.g.
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

  public Optional<PipelineManifest> loadAnyPipeline(Path workspaceDir) {
    return loadPipelineManifest(workspaceDir, "pipeline")
        // TODO: Sort by date, load first one by date creation
        .or(() -> loadPipelineManifests(workspaceDir).stream().findFirst());
  }

  public List<PipelineManifest> loadPipelineManifests(Path workspaceDir) {
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

  //TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of hardcode
  private Path findRootManifest(Path workspaceDir) {
    Path seedPath = resolveYamlFile(workspaceDir, "seed");
    if (Files.exists(seedPath)) {
      return seedPath;
    }
    Path rootPath = resolveYamlFile(workspaceDir, "root");
    if (Files.exists(rootPath)) {
      return rootPath;
    }

    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.root)
        .map(ManifestObject::filepath)
        .findFirst()
        .orElse(null);
  }

  //TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of hardcode
  private Path findToolsManifest(Path workspaceDir) {
    Path toolsPath = resolveYamlFile(workspaceDir, ".mt/tools");
    if (Files.exists(toolsPath)) {
      return toolsPath;
    }

    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.tools)
        .map(ManifestObject::filepath)
        .findFirst()
        .orElse(null);
  }

  //TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of hardcode
  @Deprecated
  private Path findPipelineManifest(Path workspaceDir, String pipelineName) {
    Path manifestsDir = workspaceDir.resolve("src/main/manifests");
    if (Files.isDirectory(manifestsDir)) {
      Path namedPath = manifestsDir.resolve(pipelineName + ".yaml");
      if (Files.exists(namedPath)) {
        return namedPath;
      }
    }

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
    return scanManifests(workspaceDir).stream()
        .filter(m -> m.type() == Type.pipeline)
        .map(ManifestObject::filepath)
        .toList();
  }

  private Path resolveYamlFile(Path workspaceDir, String name) {
    var path1 = workspaceDir.resolve(name + ".yml");
    var path2 = workspaceDir.resolve(name + ".yaml");

    if(Files.exists(path1)) {
      return path1;
    }

    return path2;
  }

  @SneakyThrows
  private List<ManifestObject> scanManifests(Path workspaceDir) {
    if (!Files.isDirectory(workspaceDir)) {
      return Collections.emptyList();
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
