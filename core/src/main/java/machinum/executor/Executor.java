package machinum.executor;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.compiler.CompilationContext;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.definition.PipelineDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.ToolsDefinition;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;

@Slf4j
@RequiredArgsConstructor
public class Executor {

  private final YamlManifestLoader manifestLoader;
  private final RootManifestCompiler rootCompiler;
  private final ToolsManifestCompiler toolsCompiler;
  private final PipelineManifestCompiler pipelineCompiler;
  private final ScriptRegistry scriptRegistry;

  public RootDefinition loadRoot(Path workspaceDir, CompilationContext ctx) throws IOException {
    Optional<RootManifest> manifest = manifestLoader.loadRootManifest(workspaceDir);
    if (manifest.isEmpty()) {
      log.warn("No root manifest found in {}", workspaceDir);
      return null;
    }

    log.info("Loading root manifest from {}", workspaceDir);
    return rootCompiler.compile(manifest.orElse(null), ctx);
  }

  public ToolsDefinition loadTools(Path workspaceDir, CompilationContext ctx) throws IOException {
    Optional<ToolsManifest> manifest = manifestLoader.loadToolsManifest(workspaceDir);
    if (manifest.isEmpty()) {
      log.debug("No tools manifest found in {}", workspaceDir);
      return null;
    }

    log.info("Loading tools manifest from {}", workspaceDir);
    return toolsCompiler.compile(manifest.orElse(null), ctx);
  }

  public PipelineDefinition loadPipeline(
      Path workspaceDir, String pipelineName, CompilationContext ctx) throws IOException {
    Optional<PipelineManifest> manifest =
        manifestLoader.loadPipelineManifest(workspaceDir, pipelineName);
    if (manifest.isEmpty()) {
      log.warn("No pipeline manifest found for name '{}' in {}", pipelineName, workspaceDir);
      return null;
    }

    log.info("Loading pipeline manifest '{}' from {}", pipelineName, workspaceDir);
    return pipelineCompiler.compile(manifest.orElse(null), ctx);
  }

  public void executePipeline(String pipelineName, Path workspaceDir, CompilationContext ctx)
      throws IOException {
    log.info("Starting pipeline execution: {} in {}", pipelineName, workspaceDir);

    // Phase 1: Load root configuration
    RootDefinition root = loadRoot(workspaceDir, ctx);
    if (root == null) {
      throw new IllegalStateException(
          "Root manifest (seed.yaml) is required but not found in " + workspaceDir);
    }

    // Phase 2: Load tools (optional for execution, required for installation)
    ToolsDefinition tools = loadTools(workspaceDir, ctx);
    if (tools == null) {
      log.debug("Tools manifest not found, continuing without tool registry");
    }

    // Phase 3: Load pipeline
    PipelineDefinition pipeline = loadPipeline(workspaceDir, pipelineName, ctx);
    if (pipeline == null) {
      throw new IllegalStateException(
          "Pipeline manifest for '" + pipelineName + "' not found in " + workspaceDir);
    }

    // Phase 4: Execute (TODO: integrate with PipelineStateMachine)
    log.info("Pipeline '{}' loaded successfully, ready for execution", pipelineName);
    // TODO: Integrate with PipelineStateMachine for actual execution
    // PipelineStateMachine machine = new PipelineStateMachine(pipeline, root, tools, ctx);
    // machine.execute();
  }
}
