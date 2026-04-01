package machinum.executor;

import java.nio.file.Path;
import java.util.Optional;
import lombok.Builder;
import machinum.compiler.CompilationContext;
import machinum.definition.PipelineDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.ToolsDefinition;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;

@Builder(toBuilder = true)
public record LifecycleContext(
    Path workspaceDir,
    CompilationContext compilationContext,
    @Deprecated(forRemoval = true)
    String runId,
    LifecyclePhase currentPhase,
    RootDefinition root,
    ToolsDefinition tools,
    PipelineDefinition pipeline,
    Optional<RootManifest> rootManifest,
    Optional<ToolsManifest> toolsManifest) {

  public enum LifecyclePhase {
    FIND,
    COMPILE,
    DOWNLOAD,
    BOOTSTRAP,
    //TODO: Add method in executor for check
    CHECK,
    RUN,
    //TODO: Change state in executor to pause, if task wasn't completed
    PAUSE,
    RESUME,
    COMPLETE
  }
}
