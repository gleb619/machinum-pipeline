package machinum.compiler;

import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.BackoffDefinition;
import machinum.definition.PipelineDefinition.ErrorStrategyDefinition;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.definition.RetryDefinition;
import machinum.manifest.PipelineBody;
import machinum.manifest.PipelineBody.ErrorStrategyManifest;
import machinum.manifest.PipelineBody.FallbackManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface FallbackCompiler extends YamlCompiler<FallbackManifest, FallbackDefinition> {

  FallbackCompiler INSTANCE = Mappers.getMapper(FallbackCompiler.class);

  @Mapping(target = "retryConfig", qualifiedByName = "compileRetry")
  @Mapping(target = "strategies", qualifiedByName = "compileStrategies")
  FallbackDefinition compile(FallbackManifest source, @Context CompilationContext ctx);

  @Named("compileRetry")
  default RetryDefinition compileRetry(
      PipelineBody.RetryManifest retry, @Context CompilationContext ctx) {
    if (retry == null) {
      throw new IllegalArgumentException("Retry can't be null");
    }
    Compiled<Integer> maxAttempts = CommonCompiler.INSTANCE.compile(retry.maxAttempts(), ctx);
    BackoffDefinition backoff = compileBackoff(retry.backoff(), ctx);
    return new RetryDefinition(maxAttempts, backoff);
  }

  @Named("compileBackoff")
  default BackoffDefinition compileBackoff(
      PipelineBody.BackoffManifest backoff, @Context CompilationContext ctx) {
    if (backoff == null) {
      throw new IllegalArgumentException("Backoff can't be null");
    }
    Compiled<PipelineBody.BackoffType> type = CommonCompiler.INSTANCE.compile(backoff.type(), ctx);
    Compiled<Duration> initialDelay =
        CommonCompiler.INSTANCE.compileDuration(backoff.initialDelay());
    Compiled<Duration> maxDelay = CommonCompiler.INSTANCE.compileDuration(backoff.maxDelay());
    Compiled<Double> multiplier = CommonCompiler.INSTANCE.compile(backoff.multiplier(), ctx);
    Compiled<Double> jitter = CommonCompiler.INSTANCE.compile(backoff.jitter(), ctx);
    return BackoffDefinition.builder()
        .type(type)
        .initialDelay(initialDelay)
        .maxDelay(maxDelay)
        .multiplier(multiplier)
        .jitter(jitter)
        .build();
  }

  @Named("compileStrategy")
  default ErrorStrategyDefinition compileStrategy(
      ErrorStrategyManifest strategy, @Context CompilationContext ctx) {
    if (strategy == null) {
      throw new IllegalArgumentException("Strategy can't be null");
    }
    Compiled<String> exception = CommonCompiler.INSTANCE.compileString(strategy.exception(), ctx);
    Compiled<PipelineBody.ErrorStrategy> errorStrategy =
        CommonCompiler.INSTANCE.compile(strategy.strategy(), ctx);
    return new ErrorStrategyDefinition(exception, errorStrategy);
  }

  @Named("compileStrategies")
  default List<ErrorStrategyDefinition> compileStrategies(
      List<ErrorStrategyManifest> strategies, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(strategies, Collections.<ErrorStrategyManifest>emptyList())
        .stream()
        .map(s -> compileStrategy(s, ctx))
        .toList();
  }
}
