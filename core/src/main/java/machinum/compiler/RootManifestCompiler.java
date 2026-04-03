package machinum.compiler;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface RootManifestCompiler extends YamlCompiler<RootManifest, RootDefinition> {

  RootManifestCompiler INSTANCE = Mappers.getMapper(RootManifestCompiler.class);

  @Mapping(target = "labels", source = "labels", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "metadata", source = "metadata", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "body", expression = "java(compileBody(source, ctx))")
  RootDefinition compile(RootManifest source, @Context CompilationContext ctx);

  @Named("compileBody")
  default RootBodyDefinition compileBody(RootManifest source, @Context CompilationContext ctx) {
    RootBody body = source.body();
    if (body == null) {
      return RootBodyDefinition.builder()
          .variables(CompiledMap.empty())
          .secrets(CompiledSecret.empty())
          .build();
    }

    ExpressionContext exprCtx = CommonCompiler.INSTANCE.createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();

    CompiledMap variables = CommonCompiler.INSTANCE.compileMap(body.variables(), ctx);
    RootExecutionDefinition execution = compileExecution(body.execution(), ctx);
    PipelineConfigDefinition config = compileConfig(body.config(), ctx);
    RootCleanupDefinition cleanup = compileCleanup(body.cleanup(), ctx);
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

  @Named("compileSecrets")
  default CompiledSecret compileSecrets(
      RootBody body,
      CompilationContext ctx,
      ExpressionContext exprCtx,
      ExpressionResolver resolver) {

    var loader = coreConfig().environmentLoader();
    Path workspaceDir = ctx.workspaceDir();

    if (body == null) {
      if (workspaceDir != null) {
        loader.loadFromDirectory(workspaceDir);
      }
      return CompiledSecret.of(loader.getAll(), exprCtx, resolver);
    }

    List<String> envFiles = body.envFiles();
    if (envFiles == null || envFiles.isEmpty()) {
      if (workspaceDir != null) {
        loader.loadFromDirectory(workspaceDir);
      }
    } else {
      Path[] paths = envFiles.stream().map(workspaceDir::resolve).toArray(Path[]::new);
      loader.loadFromPaths(paths);
    }

    Map<String, String> merged = new HashMap<>(loader.getAll());
    Map<String, String> inlineEnv = body.env();
    if (inlineEnv != null) {
      merged.putAll(inlineEnv);
    }

    return CompiledSecret.of(merged, exprCtx, resolver);
  }

  default RootExecutionDefinition compileExecution(
      RootExecutionManifest exec, @Context CompilationContext ctx) {
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
        ? CommonCompiler.INSTANCE.compileString(snapshot.mode(), ctx)
        : CompiledConstant.of(null);

    return RootExecutionDefinition.builder()
        .parallel(parallel)
        .maxConcurrency(maxConcurrency)
        .manifestSnapshotEnabled(snapshotEnabled)
        .manifestSnapshotMode(snapshotMode)
        .build();
  }

  default PipelineConfigDefinition compileConfig(
      PipelineConfigManifest cfg, @Context CompilationContext ctx) {
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

  default PipelineExecutionDefinition compilePipelineExecution(
      PipelineExecution exec, @Context CompilationContext ctx) {
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

  default RootCleanupDefinition compileCleanup(
      RootCleanupManifest cleanup, @Context CompilationContext ctx) {
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

  default ErrorHandlingDefinition compileErrorHandling(
      ErrorHandlingManifest eh, @Context CompilationContext ctx) {
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

  default RetryDefinition compileRetry(RetryManifest retry, @Context CompilationContext ctx) {
    if (retry == null) {
      return null;
    }
    Compiled<Integer> maxAttempts = CommonCompiler.INSTANCE.compileConstant(retry.maxAttempts());
    BackoffDefinition backoff = compileBackoff(retry.backoff(), ctx);
    return RetryDefinition.builder().maxAttempts(maxAttempts).backoff(backoff).build();
  }

  default BackoffDefinition compileBackoff(
      BackoffManifest backoff, @Context CompilationContext ctx) {
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

  default ErrorStrategyDefinition compileStrategy(
      ErrorStrategyManifest strategy, @Context CompilationContext ctx) {
    if (strategy == null) {
      return null;
    }
    return ErrorStrategyDefinition.builder()
        .exception(CommonCompiler.INSTANCE.compileString(strategy.exception(), ctx))
        .strategy(CommonCompiler.INSTANCE.compileConstant(strategy.strategy()))
        .build();
  }
}
