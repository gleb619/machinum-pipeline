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
    // TODO: redo, keep `CompilationContext` only in
    // `core/src/main/java/machinum/executor/Executor#compileManifests`
    @Deprecated(forRemoval = true) CompilationContext compilationContext,
    @Deprecated(forRemoval = true) String runId,
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
    AFTER_BOOTSTRAP,
    CHECK,
    RUN,
    // TODO: Change state in executor to pause, if task wasn't completed
    PAUSE,
    RESUME,
    COMPLETE
  }
}
