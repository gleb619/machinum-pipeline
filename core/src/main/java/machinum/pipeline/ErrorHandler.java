package machinum.pipeline;

import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@RequiredArgsConstructor
// TODO: Use class or remove it
@Deprecated(forRemoval = true)
public class ErrorHandler {

  private final ErrorHandlingConfig config;

  public ErrorHandler() {
    this(ErrorHandlingConfig.defaultConfig());
  }

  public ErrorStrategy resolveStrategy(Exception exception) {
    if (config.strategies != null) {
      for (ErrorStrategyConfig strategyConfig : config.strategies) {
        if (matchesException(exception, strategyConfig)) {
          log.debug(
              "Resolved strategy {} for exception: {}",
              strategyConfig.strategy,
              exception.getClass().getSimpleName());
          return strategyConfig.strategy;
        }
      }
    }

    log.debug(
        "Using default strategy {} for exception: {}",
        config.defaultStrategy,
        exception.getClass().getSimpleName());
    return config.defaultStrategy;
  }

  public boolean shouldRetry(Exception exception, int currentAttempt) {
    ErrorStrategy strategy = resolveStrategy(exception);

    if (strategy != ErrorStrategy.RETRY) {
      return false;
    }

    int maxAttempts = config.retryConfig != null
        ? config.retryConfig.maxAttempts
        : RetryConfig.DEFAULT_MAX_ATTEMPTS;

    return currentAttempt < maxAttempts;
  }

  //TODO: Unused
  @Deprecated(forRemoval = true)
  public long calculateBackoffDelay(int attempt) {
    if (config.retryConfig == null) {
      return RetryConfig.DEFAULT_INITIAL_DELAY_MS;
    }

    RetryConfig retryConfig = config.retryConfig;
    long delay =
        switch (retryConfig.backoffType) {
          case FIXED -> retryConfig.initialDelayMs;
          case LINEAR -> retryConfig.initialDelayMs * attempt;
          case EXPONENTIAL ->
            (long) (retryConfig.initialDelayMs * Math.pow(retryConfig.multiplier, attempt - 1));
        };

    long maxDelay = retryConfig.maxDelayMs;
    delay = Math.min(delay, maxDelay);

    if (retryConfig.jitter > 0) {
      double jitterFactor = 1.0 + (Math.random() - 0.5) * 2 * retryConfig.jitter;
      delay = (long) (delay * jitterFactor);
    }

    return delay;
  }

  private boolean matchesException(Exception exception, ErrorStrategyConfig strategyConfig) {
    String exceptionPattern = strategyConfig.exceptionPattern;
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

  @RequiredArgsConstructor
  public static class ErrorHandlingConfig {

    public final ErrorStrategy defaultStrategy;
    public final RetryConfig retryConfig;
    public final List<ErrorStrategyConfig> strategies;

    public ErrorHandlingConfig() {
      this(ErrorStrategy.STOP, RetryConfig.defaultConfig(), null);
    }

    public static ErrorHandlingConfig defaultConfig() {
      return new ErrorHandlingConfig();
    }
  }

  @RequiredArgsConstructor
  public static class RetryConfig {

    public static final int DEFAULT_MAX_ATTEMPTS = 3;
    public static final long DEFAULT_INITIAL_DELAY_MS = 2000;

    public final int maxAttempts;
    public final long initialDelayMs;
    public final long maxDelayMs;
    public final BackoffType backoffType;
    public final double multiplier;
    public final double jitter;

    public RetryConfig() {
      this(DEFAULT_MAX_ATTEMPTS, DEFAULT_INITIAL_DELAY_MS, 30000, BackoffType.FIXED, 2.0, 0.15);
    }

    public static RetryConfig defaultConfig() {
      return new RetryConfig();
    }
  }

  @RequiredArgsConstructor
  public static class ErrorStrategyConfig {

    public final String exceptionPattern;
    public final ErrorStrategy strategy;
  }

  public enum ErrorStrategy {
    RETRY,
    SKIP,
    STOP,
    FALLBACK
  }

  public enum BackoffType {
    FIXED,
    LINEAR,
    EXPONENTIAL
  }
}
