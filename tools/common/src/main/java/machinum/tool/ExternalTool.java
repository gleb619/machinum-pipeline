package machinum.tool;

import java.nio.file.Path;
import java.time.Duration;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;
import machinum.Tool;
import machinum.manifest.ToolManifestDepricated;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public abstract class ExternalTool implements Tool {

  protected ToolManifestDepricated definition;

  protected String runtime;

  protected Path workDir;

  @Builder.Default
  protected Duration timeout = Duration.ofSeconds(30);

  @Builder.Default
  protected RetryPolicy retryPolicy = RetryPolicy.defaultPolicy();

  @Builder.Default
  protected ExecutionTarget executionTarget = ExecutionTarget.LOCAL;

  @Override
  public ToolManifestDepricated definition() {
    return definition;
  }

  @Override
  public void validate() {
    if (workDir != null && !workDir.toFile().exists()) {
      throw new IllegalStateException("Working directory does not exist: " + workDir);
    }

    if (timeout != null && (timeout.isNegative() || timeout.isZero())) {
      throw new IllegalStateException("Timeout must be positive");
    }
  }

  @Data
  @Builder
  @NoArgsConstructor
  @AllArgsConstructor
  public static class RetryPolicy {

    private int maxAttempts;

    private Duration initialDelay;

    private double multiplier;

    private double jitter;

    public static RetryPolicy defaultPolicy() {
      return new RetryPolicy(0, Duration.ofSeconds(1), 1.0, 0.0);
    }

    public static RetryPolicy fixed(int maxAttempts, Duration delay) {
      return new RetryPolicy(maxAttempts, delay, 1.0, 0.0);
    }

    public static RetryPolicy exponential(
        int maxAttempts, Duration initialDelay, double multiplier) {
      return new RetryPolicy(maxAttempts, initialDelay, multiplier, 0.1);
    }
  }

  @AllArgsConstructor
  @Getter
  public enum ExecutionTarget {
    LOCAL("local"),
    REMOTE("remote"),
    DOCKER("docker");

    private final String name;
  }
}
