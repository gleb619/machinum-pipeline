package machinum.compiler;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.BackoffDefinition;
import machinum.definition.PipelineConfigDefinition;
import machinum.definition.PipelineDefinition.ErrorHandlingDefinition;
import machinum.definition.PipelineDefinition.ErrorStrategyDefinition;
import machinum.definition.PipelineExecutionDefinition;
import machinum.definition.RetryDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.RootDefinition.RootBodyDefinition;
import machinum.definition.RootDefinition.RootCleanupDefinition;
import machinum.definition.RootDefinition.RootExecutionDefinition;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.manifest.PipelineBody.BackoffManifest;
import machinum.manifest.PipelineBody.ErrorHandlingManifest;
import machinum.manifest.PipelineBody.ErrorStrategyManifest;
import machinum.manifest.PipelineBody.RetryManifest;
import machinum.manifest.PipelineConfigManifest;
import machinum.manifest.PipelineConfigManifest.ManifestSnapshotConfig;
import machinum.manifest.PipelineConfigManifest.PipelineExecution;
import machinum.manifest.RootBody;
import machinum.manifest.RootBody.RootCleanupManifest;
import machinum.manifest.RootBody.RootExecutionManifest;
import machinum.manifest.RootManifest;

@Slf4j
//TODO: Redo to `mapstruct`
@Deprecated(forRemoval = true)
public class RootManifestCompiler implements YamlCompiler<RootManifest, RootDefinition> {

  public static final RootManifestCompiler INSTANCE = new RootManifestCompiler();

  @Override
  public RootDefinition compile(RootManifest source, CompilationContext ctx) {
    validate(source);

    ExpressionContext exprCtx = CommonCompiler.INSTANCE.createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();

    RootBodyDefinition body = compileBody(source, ctx, exprCtx, resolver);

    return RootDefinition.builder()
        .version(source.version())
        .type(source.type())
        .name(source.name())
        .description(source.description())
        .labels(CommonCompiler.INSTANCE.compileSimpleMap(source.labels()))
        .metadata(CommonCompiler.INSTANCE.compileSimpleMap(source.metadata()))
        .body(body)
        .build();
  }

  private RootBodyDefinition compileBody(
      RootManifest source,
      CompilationContext ctx,
      ExpressionContext exprCtx,
      ExpressionResolver resolver) {
    RootBody body = source.body();
    if (body == null) {
      return null;
    }

    CompiledMap variables = CommonCompiler.INSTANCE.compileMap(body.variables(), ctx);
    RootExecutionDefinition execution = compileExecution(body.execution());
    PipelineConfigDefinition config = compileConfig(body.config(), ctx);
    RootCleanupDefinition cleanup = compileCleanup(body.cleanup());
    ErrorHandlingDefinition errorHandling = compileErrorHandling(body.errorHandling(), ctx);
    CompiledSecret secrets = compileSecrets(body, ctx, exprCtx, resolver);

    return RootBodyDefinition.builder()
        .variables(variables)
        .execution(execution)
        .config(config)
        .cleanup(cleanup)
        .errorHandling(errorHandling)
        .secrets(secrets)
        .build();
  }

  private CompiledSecret compileSecrets(
      RootBody body,
      CompilationContext ctx,
      ExpressionContext exprCtx,
      ExpressionResolver resolver) {

    EnvironmentLoader loader = coreConfig().environmentLoader();
    Path workspaceDir = ctx.workspaceDir();

    List<String> envFiles = body.envFiles();
    if (envFiles == null || envFiles.isEmpty()) {
      loader.loadFromDirectory(workspaceDir);
      log.debug("No envFiles specified, loading .env/.ENV from workspace root: {}", workspaceDir);
    } else {
      Path[] paths = envFiles.stream().map(workspaceDir::resolve).toArray(Path[]::new);
      loader.loadFromPaths(paths);
      log.debug("Loaded env from specified files: {}", envFiles);
    }

    Map<String, String> merged = new HashMap<>(loader.getAll());
    Map<String, String> inlineEnv = body.env();
    if (inlineEnv != null) {
      merged.putAll(inlineEnv);
    }

    return CompiledSecret.of(merged, exprCtx, resolver);
  }

  private RootExecutionDefinition compileExecution(RootExecutionManifest exec) {
    if (exec == null) {
      return null;
    }
    Compiled<Boolean> parallel = CommonCompiler.INSTANCE.compileConstant(exec.parallel());
    Compiled<Integer> maxConcurrency =
        CommonCompiler.INSTANCE.compileConstant(exec.maxConcurrency());

    ManifestSnapshotConfig snapshot = exec.manifestSnapshot();
    Compiled<Boolean> snapshotEnabled = snapshot != null
        ? CommonCompiler.INSTANCE.compileConstant(snapshot.enabled())
        : CompiledConstant.of(null);
    Compiled<String> snapshotMode = snapshot != null
        ? CommonCompiler.INSTANCE.compileConstant(snapshot.mode())
        : CompiledConstant.of(null);

    return RootExecutionDefinition.builder()
        .parallel(parallel)
        .maxConcurrency(maxConcurrency)
        .manifestSnapshotEnabled(snapshotEnabled)
        .manifestSnapshotMode(snapshotMode)
        .build();
  }

  private PipelineConfigDefinition compileConfig(
      PipelineConfigManifest cfg, CompilationContext ctx) {
    if (cfg == null) {
      return null;
    }

    Compiled<Integer> batchSize = CommonCompiler.INSTANCE.compileConstant(cfg.batchSize());
    Compiled<Integer> windowBatchSize =
        CommonCompiler.INSTANCE.compileConstant(cfg.windowBatchSize());
    Compiled<String> cooldown = CommonCompiler.INSTANCE.compileString(cfg.cooldown(), ctx);
    Compiled<Boolean> allowOverrideMode =
        CommonCompiler.INSTANCE.compileConstant(cfg.allowOverrideMode());

    PipelineExecutionDefinition execution = compilePipelineExecution(cfg.execution(), ctx);

    return PipelineConfigDefinition.builder()
        .batchSize(batchSize)
        .windowBatchSize(windowBatchSize)
        .cooldown(cooldown)
        .allowOverrideMode(allowOverrideMode)
        .execution(execution)
        .build();
  }

  private PipelineExecutionDefinition compilePipelineExecution(
      PipelineExecution exec, CompilationContext ctx) {
    if (exec == null) {
      return null;
    }

    ManifestSnapshotConfig snapshot = exec.manifestSnapshot();
    Compiled<Boolean> snapshotEnabled = snapshot != null
        ? CommonCompiler.INSTANCE.compileConstant(snapshot.enabled())
        : CompiledConstant.of(null);
    Compiled<String> snapshotMode = snapshot != null
        ? CommonCompiler.INSTANCE.compileString(snapshot.mode(), ctx)
        : CompiledConstant.of(null);
    Compiled<String> mode = CommonCompiler.INSTANCE.compileString(exec.mode(), ctx);
    Compiled<Integer> maxConcurrency =
        CommonCompiler.INSTANCE.compileConstant(exec.maxConcurrency());

    return PipelineExecutionDefinition.builder()
        .manifestSnapshotEnabled(snapshotEnabled)
        .manifestSnapshotMode(snapshotMode)
        .mode(mode)
        .maxConcurrency(maxConcurrency)
        .build();
  }

  private RootCleanupDefinition compileCleanup(RootCleanupManifest cleanup) {
    if (cleanup == null) {
      return null;
    }
    return RootCleanupDefinition.builder()
        .success(CommonCompiler.INSTANCE.compileConstant(cleanup.success()))
        .failed(CommonCompiler.INSTANCE.compileConstant(cleanup.failed()))
        .successRuns(CommonCompiler.INSTANCE.compileConstant(cleanup.successRuns()))
        .failedRuns(CommonCompiler.INSTANCE.compileConstant(cleanup.failedRuns()))
        .build();
  }

  private ErrorHandlingDefinition compileErrorHandling(
      ErrorHandlingManifest eh, CompilationContext ctx) {
    if (eh == null) {
      return null;
    }

    Compiled<String> defaultStrategy =
        CommonCompiler.INSTANCE.compileString(eh.defaultStrategy(), ctx);
    RetryDefinition retryConfig = compileRetry(eh.retryConfig(), ctx);
    List<ErrorStrategyDefinition> strategies = eh.strategies() != null
        ? eh.strategies().stream().map(s -> compileStrategy(s, ctx)).toList()
        : Collections.emptyList();

    return ErrorHandlingDefinition.builder()
        .defaultStrategy(defaultStrategy)
        .retryConfig(retryConfig)
        .strategies(strategies)
        .build();
  }

  private RetryDefinition compileRetry(RetryManifest retry, CompilationContext ctx) {
    if (retry == null) {
      return null;
    }
    Compiled<Integer> maxAttempts = CommonCompiler.INSTANCE.compileConstant(retry.maxAttempts());
    BackoffDefinition backoff = compileBackoff(retry.backoff(), ctx);
    return RetryDefinition.builder().maxAttempts(maxAttempts).backoff(backoff).build();
  }

  private BackoffDefinition compileBackoff(BackoffManifest backoff, CompilationContext ctx) {
    if (backoff == null) {
      return null;
    }
    return BackoffDefinition.builder()
        .type(CommonCompiler.INSTANCE.compileConstant(backoff.type()))
        .initialDelay(CommonCompiler.INSTANCE.compileString(backoff.initialDelay(), ctx))
        .maxDelay(CommonCompiler.INSTANCE.compileString(backoff.maxDelay(), ctx))
        .multiplier(CommonCompiler.INSTANCE.compileConstant(backoff.multiplier()))
        .jitter(CommonCompiler.INSTANCE.compileConstant(backoff.jitter()))
        .build();
  }

  private ErrorStrategyDefinition compileStrategy(
      ErrorStrategyManifest strategy, CompilationContext ctx) {
    if (strategy == null) {
      return null;
    }
    return ErrorStrategyDefinition.builder()
        .exception(CommonCompiler.INSTANCE.compileString(strategy.exception(), ctx))
        .strategy(CommonCompiler.INSTANCE.compileConstant(strategy.strategy()))
        .build();
  }

  private void validate(RootManifest source) {
    if (source == null) {
      throw new IllegalArgumentException("Root manifest can't be null");
    }
  }
}
