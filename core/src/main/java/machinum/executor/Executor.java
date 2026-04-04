package machinum.executor;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.compiler.CompilationContext;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.definition.PipelineDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.ToolsDefinition;
import machinum.executor.PhaseContext.LifecyclePhase;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineManifest;
import machinum.manifest.RootManifest;
import machinum.manifest.ToolsManifest;
import machinum.pipeline.ErrorStrategyResolver;
import machinum.tool.ToolRegistry;
import tools.jackson.databind.ObjectMapper;

@Slf4j
@RequiredArgsConstructor
public class Executor {

  private final YamlManifestLoader manifestLoader;
  private final RootManifestCompiler rootCompiler;
  private final ToolsManifestCompiler toolsCompiler;
  private final PipelineManifestCompiler pipelineCompiler;
  private final ErrorStrategyResolver errorStrategyResolver;
  private final ToolRegistry toolRegistry;
  private final ExpressionResolver expressionResolver;
  private final ScriptRegistry scriptRegistry;
  private final ToolsExecutor toolsExecutor;
  private final ObjectMapper objectMapper;

  public ExecutorChain chain(Path workspaceDir) {
    return new ExecutorChain(workspaceDir, this);
  }

  public LifecycleContext findManifests(Path workspaceDir) {
    log.info("Finding manifests in {}", workspaceDir);

    String runId = UUID.randomUUID().toString();
    //TODO: move to compilation phase
    @Deprecated(forRemoval = true)
    CompilationContext compilationContext =
        CompilationContext.builder().runId(runId).workspaceDir(workspaceDir).build();

    Optional<RootManifest> rootManifest = manifestLoader.loadRootManifest(workspaceDir);
    Optional<ToolsManifest> toolsManifest = manifestLoader.loadToolsManifest(workspaceDir);
    Optional<PipelineManifest> pipelineManifest = manifestLoader.loadAnyPipeline(workspaceDir);

    LifecyclePhase phase = LifecyclePhase.FIND;
    LifecycleContext ctx = LifecycleContext.builder()
        .workspaceDir(workspaceDir)
        .compilationContext(compilationContext)
        .runId(runId)
        .data(new LinkedHashMap<>(Map.of(phase, PhaseContext.empty(phase))))
        .currentPhase(phase)
        .rootManifest(rootManifest)
        .toolsManifest(toolsManifest)
        .pipelineManifest(pipelineManifest)
        .build();

    log.info(
        "Found manifests: root={}, tools={}", rootManifest.isPresent(), toolsManifest.isPresent());

    return ctx;
  }

  public LifecycleContext setDefaults(LifecycleContext ctx) {
    log.info("Set defaults manifests");
    var newCtx = ctx.toBuilder();
    if (ctx.rootManifest().isEmpty()) {
      newCtx.rootManifest(
          Optional.of(RootManifest.empty()));
    }
    if (ctx.toolsManifest().isEmpty()) {
      newCtx.toolsManifest(
          Optional.of(ToolsManifest.empty()));
    }
    if (ctx.pipelineManifest().isEmpty()) {
      newCtx.pipelineManifest(
          Optional.of(PipelineManifest.empty()));
    }

    return newCtx.build();
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

    log.info("Compiled manifests: root={}, hasTools={}", root, tools != null);

    return compiledCtx;
  }

  public LifecycleContext executeDownload(LifecycleContext ctx) {
    return toolsExecutor.executeDownload(ctx);
  }

  public LifecycleContext executeBootstrap(LifecycleContext ctx, boolean force) {
    return toolsExecutor.executeBootstrap(ctx.toBuilder()
        .currentPhase(LifecyclePhase.BOOTSTRAP)
        .build(), force);
  }

  public LifecycleContext executeAfterBootstrap(LifecycleContext ctx) {
    return toolsExecutor.executeAfterBootstrap(ctx.toBuilder()
        .currentPhase(LifecyclePhase.AFTER_BOOTSTRAP)
        .build());
  }

  //TODO: USe `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` here
  public LifecycleContext verify(LifecycleContext ctx) {
    Path workspaceDir = ctx.workspaceDir();
    log.debug("Verifying tools are bootstrapped in {}", workspaceDir);

    Path mtDir = workspaceDir.resolve(".mt");
    if (Files.notExists(mtDir)) {
      log.warn("No .mt directory found in {} - run 'setup' first", workspaceDir);
      throw new IllegalStateException("Work dir doesn't found, please run `setup` command first");
    }

    Optional<ToolsManifest> toolsManifest = manifestLoader.loadToolsManifest(workspaceDir);
    if (toolsManifest.isEmpty()) {
      log.warn("No tools manifest (.mt/tools.yaml) found in {}", workspaceDir);
      throw new IllegalStateException("tools manifest doesn't found, please run `setup` command first");
    }

    log.debug("Tools verification passed for {}", workspaceDir);
    return ctx;
  }

  //TODO: Add support of resume
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

    log.info("Pipeline '{}' loaded successfully, executing run", pipelineName);
    
    return executeRun(pipelineName, workspaceDir);
  }

  //TODO: Update method, accept `LifecycleContext` with `PhaseContext` for details
  public LifecycleContext executeRun(String pipelineName, Path workspaceDir) {
    log.info("Starting RUN lifecycle: pipeline={} in {}", pipelineName, workspaceDir);

    LifecycleContext ctx = findManifests(workspaceDir);

    ctx = compileManifests(ctx);

    PipelineDefinition pipeline =
        loadPipeline(workspaceDir, pipelineName, ctx.compilationContext());
    if (pipeline == null) {
      throw new IllegalStateException(
          "Pipeline manifest for '" + pipelineName + "' not found in " + workspaceDir);
    }
    ctx = ctx.toBuilder().pipeline(pipeline)
        .currentPhase(LifecyclePhase.RUN)
        .build();

    // TODO: Use `core/src/main/java/machinum/config/CoreConfig.java` here
    PipelineExecutor pipelineExecutor = new PipelineExecutor(
        toolRegistry, expressionResolver, scriptRegistry, errorStrategyResolver, objectMapper);
    return pipelineExecutor.executeRun(ctx, pipeline);
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

  @RequiredArgsConstructor
  public static class ExecutorChain {

    private final Path workspaceDir;
    private final Executor executor;
    private final AtomicReference<LifecycleContext> context = new AtomicReference<>();

    public ExecutorChain findManifests() {
      context.set(executor.findManifests(workspaceDir));

      return this;
    }

    public ExecutorChain setDefaults() {
      context.set(executor.setDefaults(context.get()));

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

    public ExecutorChain executeAfterBootstrap() {
      context.set(executor.executeAfterBootstrap(context.get()));

      return this;
    }

    public ExecutorChain verify() {
      context.set(executor.verify(context.get()));

      return this;
    }

    public ExecutorChain executePipeline() {
      //TODO: update `executePipeline` method first
      //context.set(executor.executePipeline(context.get()));

      return this;
    }
  }
}
