package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.BackoffDefinition;
import machinum.definition.PipelineDefinition.ErrorHandlingDefinition;
import machinum.definition.PipelineDefinition.ErrorStrategyDefinition;
import machinum.definition.RetryDefinition;
import machinum.manifest.PipelineBody;
import machinum.manifest.PipelineBody.ErrorHandlingManifest;
import machinum.manifest.PipelineBody.ErrorStrategyManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ErrorHandlingCompiler
    extends YamlCompiler<ErrorHandlingManifest, ErrorHandlingDefinition> {

  ErrorHandlingCompiler INSTANCE = Mappers.getMapper(ErrorHandlingCompiler.class);

  @Mapping(target = "defaultStrategy", qualifiedByName = "compileString")
  @Mapping(target = "retryConfig", qualifiedByName = "compileRetry")
  @Mapping(target = "strategies", qualifiedByName = "compileStrategies")
  ErrorHandlingDefinition compile(ErrorHandlingManifest source, @Context CompilationContext ctx);

  @Named("compileRetry")
  default RetryDefinition compileRetry(
      PipelineBody.RetryManifest retry, @Context CompilationContext ctx) {
    if (retry == null) {
      throw new IllegalArgumentException("Retry can't be null");
    }
    Compiled<Integer> maxAttempts = CommonCompiler.INSTANCE.compileConstant(retry.maxAttempts());
    BackoffDefinition backoff = compileBackoff(retry.backoff(), ctx);
    return new RetryDefinition(maxAttempts, backoff);
  }

  @Named("compileBackoff")
  default BackoffDefinition compileBackoff(
      PipelineBody.BackoffManifest backoff, @Context CompilationContext ctx) {
    if (backoff == null) {
      throw new IllegalArgumentException("Backoff can't be null");
    }
    Compiled<PipelineBody.BackoffType> type =
        CommonCompiler.INSTANCE.compileConstant(backoff.type());
    Compiled<String> initialDelay =
        CommonCompiler.INSTANCE.compileString(backoff.initialDelay(), ctx);
    Compiled<String> maxDelay = CommonCompiler.INSTANCE.compileString(backoff.maxDelay(), ctx);
    Compiled<Double> multiplier = CommonCompiler.INSTANCE.compileConstant(backoff.multiplier());
    Compiled<Double> jitter = CommonCompiler.INSTANCE.compileConstant(backoff.jitter());
    return new BackoffDefinition(type, initialDelay, maxDelay, multiplier, jitter);
  }

  @Named("compileStrategy")
  default ErrorStrategyDefinition compileStrategy(
      ErrorStrategyManifest strategy, @Context CompilationContext ctx) {
    if (strategy == null) {
      throw new IllegalArgumentException("Strategy can't be null");
    }
    Compiled<String> exception = CommonCompiler.INSTANCE.compileString(strategy.exception(), ctx);
    Compiled<PipelineBody.ErrorStrategy> errorStrategy =
        CommonCompiler.INSTANCE.compileConstant(strategy.strategy());
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
