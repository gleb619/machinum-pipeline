package machinum.executor;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import lombok.Builder;
import machinum.compiler.CompilationContext;
import machinum.definition.PipelineDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.ToolsDefinition;
import machinum.executor.PhaseContext.LifecyclePhase;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;

@Builder(toBuilder = true)
public record LifecycleContext(
    Path workspaceDir,
    // TODO: redo, move `CompilationContext` to `data` field
    // `core/src/main/java/machinum/executor/Executor#compileManifests`
    @Deprecated(forRemoval = true) CompilationContext compilationContext,
    // TODO: redo, move `runId` to `data` field(e.g. create runContext)
    @Deprecated(forRemoval = true) String runId,
    Map<LifecyclePhase, PhaseContext> data,
    LifecyclePhase currentPhase,
    RootDefinition root,
    ToolsDefinition tools,
    PipelineDefinition pipeline,
    Optional<RootManifest> rootManifest,
    Optional<ToolsManifest> toolsManifest,
    Optional<PipelineManifest> pipelineManifest) {

  public void registerContext(PhaseContext context) {
    data.put(currentPhase, context);
  }
}
