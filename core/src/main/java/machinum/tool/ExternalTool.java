package machinum.tool;

import java.nio.file.Path;
import java.time.Duration;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;
import machinum.yaml.ToolDefinition;

/**
 * Base class for external tools that execute outside the JVM (shell scripts, Groovy scripts, Docker
 * containers).
 *
 * <p>Provides common functionality for timeout enforcement, retry policy, and execution target
 * configuration.
 */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public abstract class ExternalTool implements Tool {

  /** Tool definition with metadata and configuration. */
  protected ToolDefinition definition;

  /** Runtime type: shell, groovy, docker, etc. */
  protected String runtime;

  /** Working directory for tool execution. */
  protected Path workDir;

  /** Maximum execution time before timeout. */
  @Builder.Default
  protected Duration timeout = Duration.ofSeconds(30);

  /** Retry policy for failed executions. */
  @Builder.Default
  protected RetryPolicy retryPolicy = RetryPolicy.defaultPolicy();

  /** Execution target: local, remote, docker. */
  @Builder.Default
  protected ExecutionTarget executionTarget = ExecutionTarget.LOCAL;

  /** Returns the tool definition (implements Tool interface). */
  @Override
  public ToolDefinition definition() {
    return definition;
  }

  /**
   * Validates the tool configuration before execution.
   *
   * @throws IllegalStateException if configuration is invalid
   */
  @Override
  public void validate() {
    if (workDir != null && !workDir.toFile().exists()) {
      throw new IllegalStateException("Working directory does not exist: " + workDir);
    }

    if (timeout != null && (timeout.isNegative() || timeout.isZero())) {
      throw new IllegalStateException("Timeout must be positive");
    }
  }

  /** Retry policy configuration for failed tool executions. */
  @Data
  @Builder
  @NoArgsConstructor
  @AllArgsConstructor
  public static class RetryPolicy {

    /** Maximum number of retry attempts. */
    private int maxAttempts;

    /** Initial delay between retries. */
    private Duration initialDelay;

    /** Multiplier for exponential backoff. */
    private double multiplier;

    /** Jitter factor (0.0-1.0) for randomization. */
    private double jitter;

    /** Creates a retry policy with fixed backoff. */
    public static RetryPolicy defaultPolicy() {
      return new RetryPolicy(0, Duration.ofSeconds(1), 1.0, 0.0);
    }

    /** Creates a retry policy with fixed backoff. */
    public static RetryPolicy fixed(int maxAttempts, Duration delay) {
      return new RetryPolicy(maxAttempts, delay, 1.0, 0.0);
    }

    /** Creates a retry policy with exponential backoff. */
    public static RetryPolicy exponential(
        int maxAttempts, Duration initialDelay, double multiplier) {
      return new RetryPolicy(maxAttempts, initialDelay, multiplier, 0.1);
    }
  }

  /** Execution target for tool invocation. */
  @AllArgsConstructor
  @Getter
  public enum ExecutionTarget {
    LOCAL("local"),
    REMOTE("remote"),
    DOCKER("docker");

    private final String name;
  }
}
