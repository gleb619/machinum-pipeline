package machinum.compiler;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import machinum.definition.BackoffDefinition;
import machinum.definition.PipelineConfigDefinition;
import machinum.definition.PipelineDefinition.ErrorStrategyDefinition;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.definition.RetryDefinition;
import machinum.definition.RootDefinition;
import machinum.definition.RootDefinition.RootBodyDefinition;
import machinum.definition.RootDefinition.RootCleanupDefinition;
import machinum.definition.RootDefinition.RootExecutionDefinition;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.manifest.PipelineBody.BackoffManifest;
import machinum.manifest.PipelineBody.ErrorStrategyManifest;
import machinum.manifest.PipelineBody.FallbackManifest;
import machinum.manifest.PipelineBody.RetryManifest;
import machinum.manifest.PipelineConfigManifest;
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

  @Mapping(target = "labels", qualifiedByName = "simpleMap")
  @Mapping(target = "metadata", qualifiedByName = "simpleMap")
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

    CompiledMap<String> variables = CommonCompiler.INSTANCE.compileMap(body.variables(), ctx);
    RootExecutionDefinition execution = compileExecution(body.execution(), ctx);
    PipelineConfigDefinition config = compileConfig(body.pipelineConfig(), ctx);
    RootCleanupDefinition cleanup = compileCleanup(body.cleanup(), ctx);
    FallbackDefinition fallback = compileFallback(body.fallback(), ctx);
    CompiledSecret secrets = compileSecrets(body, ctx, exprCtx, resolver);

    return RootBodyDefinition.builder()
        .variables(variables)
        .execution(execution)
        .config(config)
        .cleanup(cleanup)
        .fallback(fallback)
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
      return CompiledSecret.from(loader.getAll(), exprCtx, resolver);
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

    return CompiledSecret.from(merged, exprCtx, resolver);
  }

  default RootExecutionDefinition compileExecution(
      RootExecutionManifest exec, @Context CompilationContext ctx) {
    if (exec == null) {
      return null;
    }
    Compiled<Boolean> parallel = CommonCompiler.INSTANCE.compile(exec.parallel(), ctx);
    Compiled<Integer> maxConcurrency = CommonCompiler.INSTANCE.compile(exec.maxConcurrency(), ctx);

    return RootExecutionDefinition.builder()
        .parallel(parallel)
        .maxConcurrency(maxConcurrency)
        .build();
  }

  default PipelineConfigDefinition compileConfig(
      PipelineConfigManifest cfg, @Context CompilationContext ctx) {
    if (cfg == null) {
      return null;
    }

    Compiled<Integer> batchSize = CommonCompiler.INSTANCE.compile(cfg.batchSize(), ctx);
    Compiled<Integer> windowBatchSize = CommonCompiler.INSTANCE.compile(cfg.windowBatchSize(), ctx);
    Compiled<Duration> cooldown = CommonCompiler.INSTANCE.compileDuration(cfg.cooldown());
    Compiled<Boolean> allowOverrideMode = CommonCompiler.INSTANCE.compile(cfg.allowOverrideMode(), ctx);

    return PipelineConfigDefinition.builder()
        .batchSize(batchSize)
        .windowBatchSize(windowBatchSize)
        .cooldown(cooldown)
        .allowOverrideMode(allowOverrideMode)
        .snapshot(cfg.snapshot())
        .build();
  }

  default RootCleanupDefinition compileCleanup(
      RootCleanupManifest cleanup, @Context CompilationContext ctx) {
    if (cleanup == null) {
      return null;
    }
    var successRuns = CommonCompiler.INSTANCE.compile(cleanup.successRuns(), ctx);
    var failedRuns = CommonCompiler.INSTANCE.compile(cleanup.failedRuns(), ctx);
    return RootCleanupDefinition.builder()
        .pass(CommonCompiler.INSTANCE.compileDuration(cleanup.pass()))
        .fail(CommonCompiler.INSTANCE.compileDuration(cleanup.fail()))
        .successRuns(CompiledConstant.of(Integer.parseInt(successRuns.get())))
        .failedRuns(CompiledConstant.of(Integer.parseInt(failedRuns.get())))
        .build();
  }

  default FallbackDefinition compileFallback(FallbackManifest eh, @Context CompilationContext ctx) {
    if (eh == null) {
      return null;
    }

    RetryDefinition retryConfig = compileRetry(eh.retryConfig(), ctx);
    List<ErrorStrategyDefinition> strategies = eh.strategies() != null
        ? eh.strategies().stream().map(s -> compileStrategy(s, ctx)).toList()
        : Collections.emptyList();

    return FallbackDefinition.builder()
        .retryConfig(retryConfig)
        .strategies(strategies)
        .build();
  }

  default RetryDefinition compileRetry(RetryManifest retry, @Context CompilationContext ctx) {
    if (retry == null) {
      return null;
    }
    Compiled<Integer> maxAttempts = CommonCompiler.INSTANCE.compile(retry.maxAttempts(), ctx);
    BackoffDefinition backoff = compileBackoff(retry.backoff(), ctx);
    return RetryDefinition.builder().maxAttempts(maxAttempts).backoff(backoff).build();
  }

  default BackoffDefinition compileBackoff(
      BackoffManifest backoff, @Context CompilationContext ctx) {
    if (backoff == null) {
      return null;
    }
    return BackoffDefinition.builder()
        .type(CommonCompiler.INSTANCE.compile(backoff.type(), ctx))
        .initialDelay(CommonCompiler.INSTANCE.compileDuration(backoff.initialDelay()))
        .maxDelay(CommonCompiler.INSTANCE.compileDuration(backoff.maxDelay()))
        .multiplier(CommonCompiler.INSTANCE.compile(backoff.multiplier(), ctx))
        .jitter(CommonCompiler.INSTANCE.compile(backoff.jitter(), ctx))
        .build();
  }

  default ErrorStrategyDefinition compileStrategy(
      ErrorStrategyManifest strategy, @Context CompilationContext ctx) {
    if (strategy == null) {
      return null;
    }
    return ErrorStrategyDefinition.builder()
        .exception(CommonCompiler.INSTANCE.compileString(strategy.exception(), ctx))
        .strategy(CommonCompiler.INSTANCE.compile(strategy.strategy(), ctx))
        .build();
  }
}
