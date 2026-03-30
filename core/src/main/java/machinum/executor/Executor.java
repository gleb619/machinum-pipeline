package machinum.executor;

import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.compiler.CompilationContext;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.definition.PipelineDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.ToolsDefinition;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;
import machinum.pipeline.ErrorHandler;
import machinum.tool.SpiToolRegistry;

@Slf4j
@RequiredArgsConstructor
public class Executor {

  private final YamlManifestLoader manifestLoader;
  private final RootManifestCompiler rootCompiler;
  private final ToolsManifestCompiler toolsCompiler;
  private final PipelineManifestCompiler pipelineCompiler;
  private final ErrorHandler errorHandler;
  private final SpiToolRegistry toolRegistry;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final ToolsExecutor toolsExecutor;

  public ExecutorChain chain(Path workspaceDir) {
    return new ExecutorChain(workspaceDir, this);
  }

  public LifecycleContext findManifests(Path workspaceDir) {
    log.info("Finding manifests in {}", workspaceDir);

    String runId = UUID.randomUUID().toString();
    CompilationContext compilationContext =
        CompilationContext.builder().runId(runId).build();

    Optional<RootManifest> rootManifest = manifestLoader.loadRootManifest(workspaceDir);
    Optional<ToolsManifest> toolsManifest = manifestLoader.loadToolsManifest(workspaceDir);

    LifecycleContext ctx = LifecycleContext.builder()
        .workspaceDir(workspaceDir)
        .compilationContext(compilationContext)
        .runId(runId)
        .currentPhase(LifecyclePhase.FIND)
        .rootManifest(rootManifest)
        .toolsManifest(toolsManifest)
        .build();

    log.info(
        "Found manifests: root={}, tools={}", rootManifest.isPresent(), toolsManifest.isPresent());

    return ctx;
  }

  public LifecycleContext compileManifests(LifecycleContext ctx) {
    log.info("Compiling manifests (phase: {})", ctx.currentPhase());

    if (ctx.rootManifest().isEmpty()) {
      throw new IllegalStateException(
          "Root manifest (seed.yaml) is required but not found in " + ctx.workspaceDir());
    }

    RootDefinition root = rootCompiler.compile(ctx.rootManifest().get(), ctx.compilationContext());
    ToolsDefinition tools = null;
    if (ctx.toolsManifest().isPresent()) {
      tools = toolsCompiler.compile(ctx.toolsManifest().get(), ctx.compilationContext());
    }

    LifecycleContext compiledCtx = ctx.toBuilder()
        .currentPhase(LifecyclePhase.COMPILE)
        .root(root)
        .tools(tools)
        .build();

    log.info("Compiled manifests: root={}, tools={}", root, tools != null);

    return compiledCtx;
  }

  public LifecycleContext executeDownload(LifecycleContext ctx) {
    return toolsExecutor.executeDownload(ctx);
  }

  public LifecycleContext executeBootstrap(LifecycleContext ctx, boolean force) {
    return toolsExecutor.executeBootstrap(ctx, force);
  }

  @Deprecated(forRemoval = true)
  public LifecycleContext executeInstall(Path workspaceDir, boolean force) {
    log.info("Starting INSTALL lifecycle in {} (force={})", workspaceDir, force);

    LifecycleContext ctx = findManifests(workspaceDir);
    ctx = compileManifests(ctx);
    ctx = executeDownload(ctx);
    ctx = executeBootstrap(ctx, force);

    LifecycleContext finalCtx =
        ctx.toBuilder().currentPhase(LifecyclePhase.COMPLETE).build();

    log.info("INSTALL lifecycle completed successfully");
    return finalCtx;
  }

  private PipelineDefinition loadPipeline(
      Path workspaceDir, String pipelineName, CompilationContext ctx) {
    Optional<PipelineManifest> manifest =
        manifestLoader.loadPipelineManifest(workspaceDir, pipelineName);
    if (manifest.isEmpty()) {
      log.debug("No pipeline manifest found for name '{}' in {}", pipelineName, workspaceDir);
      return null;
    }

    log.info("Loading pipeline manifest '{}' from {}", pipelineName, workspaceDir);
    return pipelineCompiler.compile(manifest.get(), ctx);
  }

  public LifecycleContext executePipeline(
      String pipelineName, Path workspaceDir, boolean resume, String runId) {

    log.info(
        "Starting PIPELINE execution: {} in {} (resume={})", pipelineName, workspaceDir, resume);

    LifecycleContext ctx = findManifests(workspaceDir);
    ctx = compileManifests(ctx);

    if (ctx.pipeline() == null) {
      Optional<PipelineManifest> pipelineManifest =
          manifestLoader.loadPipelineManifest(workspaceDir, pipelineName);
      if (pipelineManifest.isPresent()) {
        PipelineDefinition pipeline =
            pipelineCompiler.compile(pipelineManifest.get(), ctx.compilationContext());
        ctx = ctx.toBuilder().pipeline(pipeline).build();
      }
    }

    if (ctx.pipeline() == null) {
      throw new IllegalStateException(
          "Pipeline manifest for '" + pipelineName + "' not found in " + workspaceDir);
    }

    log.info("Pipeline '{}' loaded successfully, ready for execution", pipelineName);
    return ctx;
  }

  public LifecycleContext executeRun(String pipelineName, Path workspaceDir) {
    log.info("Starting RUN lifecycle: pipeline={} in {}", pipelineName, workspaceDir);

    // 1. FIND manifests
    LifecycleContext ctx = findManifests(workspaceDir);

    // 2. COMPILE manifests
    ctx = compileManifests(ctx);

    // 3. Load pipeline
    PipelineDefinition pipeline =
        loadPipeline(workspaceDir, pipelineName, ctx.compilationContext());
    if (pipeline == null) {
      throw new IllegalStateException(
          "Pipeline manifest for '" + pipelineName + "' not found in " + workspaceDir);
    }
    ctx = ctx.toBuilder().pipeline(pipeline).build();

    // 4. Delegate to PipelineExecutor
    PipelineExecutor pipelineExecutor =
        new PipelineExecutor(toolRegistry, expressionResolver, scriptRegistry, errorHandler);
    return pipelineExecutor.executeRun(ctx, pipeline);
  }

  @Builder(toBuilder = true)
  public record LifecycleContext(
      Path workspaceDir,
      CompilationContext compilationContext,
      String runId,
      LifecyclePhase currentPhase,
      RootDefinition root,
      ToolsDefinition tools,
      PipelineDefinition pipeline,
      Optional<RootManifest> rootManifest,
      Optional<ToolsManifest> toolsManifest) {}

  public enum LifecyclePhase {
    FIND,
    COMPILE,
    DOWNLOAD,
    BOOTSTRAP,
    RUN,
    RESUME,
    COMPLETE
  }

  @RequiredArgsConstructor
  public static class ExecutorChain {

    private final Path workspaceDir;
    private final Executor executor;
    private final AtomicReference<LifecycleContext> context = new AtomicReference<>();

    public ExecutorChain findManifests() {
      context.set(executor.findManifests(workspaceDir));

      return this;
    }

    public ExecutorChain compileManifests() {
      context.set(executor.compileManifests(context.get()));

      return this;
    }

    public ExecutorChain executeDownload() {
      context.set(executor.executeDownload(context.get()));

      return this;
    }

    public ExecutorChain executeBootstrap(boolean force) {
      context.set(executor.executeBootstrap(context.get(), force));

      return this;
    }
  }
}
