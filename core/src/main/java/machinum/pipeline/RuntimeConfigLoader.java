package machinum.pipeline;

import java.io.IOException;
import java.nio.file.Path;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import machinum.yaml.PipelineManifest;
import machinum.yaml.RootManifest;
import machinum.yaml.ToolsManifest;
import machinum.yaml.YamlManifestLoader;

/** Loads and validates workspace manifests for CLI runtime. */
@Builder
@RequiredArgsConstructor
public class RuntimeConfigLoader {

  private final YamlManifestLoader yamlLoader;

  /**
   * Loads all workspace manifests from the given workspace directory.
   *
   * @param workspaceDir the workspace root directory
   * @return the loaded runtime configuration
   * @throws IOException if loading fails
   */
  public RuntimeConfig load(Path workspaceDir) throws IOException {
    Path rootPath = workspaceDir.resolve("root.yaml");
    Path toolsPath = workspaceDir.resolve(".mt/tools.yaml");

    RootManifest root = yamlLoader.loadRootManifest(rootPath);
    ToolsManifest tools = yamlLoader.loadToolsManifest(toolsPath);

    return new RuntimeConfig(root, tools, workspaceDir);
  }

  /**
   * Loads a pipeline manifest by name.
   *
   * @param workspaceDir the workspace root directory
   * @param pipelineName the pipeline name
   * @return the loaded pipeline manifest
   * @throws IOException if loading fails
   */
  public PipelineManifest loadPipeline(Path workspaceDir, String pipelineName) throws IOException {
    Path pipelinePath = workspaceDir.resolve(".mt/pipelines").resolve(pipelineName + ".yaml");
    return yamlLoader.loadPipelineManifest(pipelinePath);
  }

  /** Holds loaded runtime configuration. */
  public record RuntimeConfig(RootManifest root, ToolsManifest tools, Path workspaceDir) {}
}
