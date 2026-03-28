package machinum.pipeline;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import machinum.yaml.PipelineManifest;
import machinum.yaml.RootManifest;
import machinum.yaml.ToolsManifest;
import machinum.yaml.YamlManifestLoader;

@Builder
@RequiredArgsConstructor
public class RuntimeConfigLoader {

  private final YamlManifestLoader yamlLoader;

  public RuntimeConfig load(Path workspaceDir) throws IOException {
    Path rootPath = workspaceDir.resolve("root.yaml");
    Path seedPath = workspaceDir.resolve("seed.yaml");
    Path toolsPath = workspaceDir.resolve(".mt/tools.yaml");

    RootManifest root;
    if (Files.exists(rootPath)) {
      root = yamlLoader.loadRootManifest(rootPath);
    } else if (Files.exists(seedPath)) {
      root = yamlLoader.loadRootManifest(seedPath);
    } else {
      throw new IllegalStateException(
          "Seed/Root file could not be found at: " + workspaceDir.toAbsolutePath());
    }
    ToolsManifest tools = yamlLoader.loadToolsManifest(toolsPath);

    return new RuntimeConfig(root, tools, workspaceDir);
  }

  // TODO: rewrite
  @Deprecated(forRemoval = true)
  public PipelineManifest loadPipeline(Path workspaceDir, String pipelineName) throws IOException {
    // TODO: replace, we jsut can find file by name. We must read all pipelines. THen in body we have a name field, and we need to select by it
    Path yamlPath = workspaceDir.resolve("src/main/manifests").resolve(pipelineName + ".yaml");
    Path ymlPath = workspaceDir.resolve("src/main/manifests").resolve(pipelineName + ".yml");

    if (Files.exists(yamlPath)) {
      return yamlLoader.loadPipelineManifest(yamlPath);
    } else if (Files.exists(ymlPath)) {
      return yamlLoader.loadPipelineManifest(ymlPath);
    }

    throw new IllegalStateException(
        "File '%s' doesn't exists at %s".formatted(pipelineName, workspaceDir.toAbsolutePath()));
  }

  public record RuntimeConfig(RootManifest root, ToolsManifest tools, Path workspaceDir) {}
}
