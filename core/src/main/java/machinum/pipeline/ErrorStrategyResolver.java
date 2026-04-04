package machinum.pipeline;

import java.time.Duration;
import java.util.List;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.BackoffDefinition;
import machinum.definition.PipelineDefinition.ErrorStrategyDefinition;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.definition.RetryDefinition;
import machinum.manifest.PipelineBody.BackoffType;
import machinum.manifest.PipelineBody.ErrorStrategy;

@Slf4j
public class ErrorStrategyResolver {

  private static final int DEFAULT_MAX_ATTEMPTS = 3;
  private static final Duration DEFAULT_INITIAL_DELAY_MS = Duration.ofSeconds(2);
  private static final Duration DEFAULT_MAX_DELAY_MS = Duration.ofSeconds(30);
  private static final double DEFAULT_MULTIPLIER = 2.0;
  private static final double DEFAULT_JITTER = 0.15;

  public ErrorStrategy resolveStrategy(Exception exception, FallbackDefinition fallback) {
    if (fallback == null) {
      log.debug(
          "No fallback config, defaulting to STOP for exception: {}",
          exception.getClass().getSimpleName());
      return ErrorStrategy.stop;
    }

    List<ErrorStrategyDefinition> strategies = fallback.strategies();
    if (strategies != null && !strategies.isEmpty()) {
      for (ErrorStrategyDefinition strategyConfig : strategies) {
        if (matchesException(exception, strategyConfig)) {
          ErrorStrategy strategy = strategyConfig.strategy() != null
              ? strategyConfig.strategy().get()
              : ErrorStrategy.stop;
          log.debug(
              "Resolved strategy {} for exception: {}",
              strategy,
              exception.getClass().getSimpleName());
          return strategy;
        }
      }
    }

    String defaultStrategy = "stop";
    log.debug(
        "Using default strategy {} for exception: {}",
        defaultStrategy,
        exception.getClass().getSimpleName());
    return parseErrorStrategy(defaultStrategy);
  }

  public Duration calculateBackoffDelay(int attempt, RetryDefinition retryConfig) {
    if (retryConfig == null) {
      return DEFAULT_INITIAL_DELAY_MS;
    }

    BackoffDefinition backoff = retryConfig.backoff();
    if (backoff == null) {
      return DEFAULT_INITIAL_DELAY_MS;
    }

    Duration initialDelay =
        backoff.initialDelay() != null ? backoff.initialDelay().get() : DEFAULT_INITIAL_DELAY_MS;
    Duration maxDelay =
        backoff.maxDelay() != null ? backoff.maxDelay().get() : DEFAULT_MAX_DELAY_MS;
    double multiplier = backoff.multiplier() != null && backoff.multiplier().get() != null
        ? backoff.multiplier().get()
        : DEFAULT_MULTIPLIER;
    double jitter = backoff.jitter() != null && backoff.jitter().get() != null
        ? backoff.jitter().get()
        : DEFAULT_JITTER;
    BackoffType backoffType = backoff.type() != null && backoff.type().get() != null
        ? backoff.type().get()
        : BackoffType.fixed;

    long delay =
        switch (backoffType) {
          case fixed -> initialDelay.toMillis();
          case linear -> initialDelay.toMillis() * attempt;
          case exponential -> (long) (initialDelay.toMillis() * Math.pow(multiplier, attempt - 1));
        };

    delay = Math.min(delay, maxDelay.toMillis());

    if (jitter > 0) {
      double jitterFactor = 1.0 + (Math.random() - 0.5) * 2 * jitter;
      delay = (long) (delay * jitterFactor);
    }

    return null;
    // return delay;
  }

  public int getMaxAttempts(RetryDefinition retryConfig) {
    if (retryConfig == null
        || retryConfig.maxAttempts() == null
        || retryConfig.maxAttempts().get() == null) {
      return DEFAULT_MAX_ATTEMPTS;
    }
    return retryConfig.maxAttempts().get();
  }

  private boolean matchesException(Exception exception, ErrorStrategyDefinition strategyConfig) {
    String exceptionPattern =
        strategyConfig.exception() != null ? strategyConfig.exception().get() : null;
    if (exceptionPattern == null || exceptionPattern.isBlank()) {
      return false;
    }

    String exceptionName = exception.getClass().getSimpleName();
    String exceptionFullName = exception.getClass().getName();

    if (exceptionPattern.equals(exceptionName) || exceptionPattern.equals(exceptionFullName)) {
      return true;
    }

    if (exceptionPattern.contains(".*") || exceptionPattern.contains("^")) {
      return exceptionName.matches(exceptionPattern) || exceptionFullName.matches(exceptionPattern);
    }

    return false;
  }

  private ErrorStrategy parseErrorStrategy(String strategy) {
    return switch (strategy.toLowerCase()) {
      case "retry" -> ErrorStrategy.retry;
      case "skip" -> ErrorStrategy.skip;
      case "fallback" -> ErrorStrategy.fallback;
      default -> ErrorStrategy.stop;
    };
  }
}
