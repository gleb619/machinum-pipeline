package machinum.pipeline;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Optional;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import machinum.executor.YamlManifestLoader;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;

@Builder
@RequiredArgsConstructor
// TODO: Remove
@Deprecated(forRemoval = true)
public class RuntimeConfigLoader {

  private final YamlManifestLoader yamlLoader;

  public RuntimeConfig load(Path workspaceDir) throws IOException {
    Optional<RootManifest> root = yamlLoader.loadRootManifest(workspaceDir);
    if (root.isEmpty()) {
      throw new IllegalStateException(
          "Seed/Root file could not be found at: " + workspaceDir.toAbsolutePath());
    }
    Optional<ToolsManifest> tools = yamlLoader.loadToolsManifest(workspaceDir);

    return new RuntimeConfig(root, tools, workspaceDir);
  }

  // TODO: rewrite
  @Deprecated(forRemoval = true)
  public Optional<PipelineManifest> loadPipeline(Path workspaceDir, String pipelineName)
      throws IOException {
    Optional<PipelineManifest> manifest =
        yamlLoader.loadPipelineManifest(workspaceDir, pipelineName);
    if (manifest.isEmpty()) {
      throw new IllegalStateException(
          "File '%s' doesn't exists at %s".formatted(pipelineName, workspaceDir.toAbsolutePath()));
    }
    return manifest;
  }

  public record RuntimeConfig(RootManifest root, ToolsManifest tools, Path workspaceDir) {}
}
