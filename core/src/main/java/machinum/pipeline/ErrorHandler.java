package machinum.pipeline;

import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/** Handles error classification and retry strategy resolution for pipeline execution. */
@Slf4j
@RequiredArgsConstructor
// TODO: Use class or remove it
@Deprecated(forRemoval = true)
public class ErrorHandler {

  private final ErrorHandlingConfig config;

  public ErrorHandler() {
    this(ErrorHandlingConfig.defaultConfig());
  }

  /**
   * Determines the error strategy for a given exception.
   *
   * @param exception the exception that occurred
   * @return the error strategy to apply
   */
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

  /**
   * Determines if a retry should be attempted.
   *
   * @param exception the exception that occurred
   * @param currentAttempt the current attempt number (1-based)
   * @return true if retry should be attempted
   */
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

  /**
   * Calculates the backoff delay before the next retry.
   *
   * @param attempt the current attempt number (1-based)
   * @return delay in milliseconds
   */
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

  /** Configuration for error handling. */
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

  /** Retry configuration. */
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

  /** Error strategy configuration. */
  @RequiredArgsConstructor
  public static class ErrorStrategyConfig {
    public final String exceptionPattern;
    public final ErrorStrategy strategy;

    public ErrorStrategyConfig() {
      this(null, ErrorStrategy.STOP);
    }
  }

  /** Error strategies enumeration. */
  public enum ErrorStrategy {
    /** Retry the operation */
    RETRY,
    /** Skip the failed operation and continue */
    SKIP,
    /** Stop the pipeline execution */
    STOP,
    /** Execute a fallback operation */
    FALLBACK
  }

  /** Backoff types for retry. */
  public enum BackoffType {
    /** Constant delay between retries */
    FIXED,
    /** Linearly increasing delay */
    LINEAR,
    /** Exponentially increasing delay */
    EXPONENTIAL
  }
}
