package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.definition.PipelineLifecycleEvent;

@Builder
public record PipelineBody(
    PipelineConfigManifest config,
    // TODO: Add support of two possible values: String, List<String>
    @Singular Map<String, String> variables,
    SourceManifest source,
    ItemsManifest items,
    @Singular List<PipelineStateManifest> states,
    @Singular Map<PipelineLifecycleEvent, List<ListenerItemManifest>> listeners,
    @JsonAlias("error-handling") ErrorHandlingManifest errorHandling)
    implements ManifestBody {

  public boolean hasSource() {
    return source != null && !source.isEmpty();
  }

  public boolean hasItems() {
    return items != null && !items.isEmpty();
  }

  @Builder
  public record ErrorHandlingManifest(
      @JsonAlias("default-strategy") String defaultStrategy,
      @JsonAlias("retry-config") RetryManifest retryConfig,
      @Singular List<ErrorStrategyManifest> strategies) {}

  @Builder
  public record RetryManifest(
      @JsonAlias("max-attempts") Integer maxAttempts, BackoffManifest backoff) {}

  @Builder
  public record BackoffManifest(
      BackoffType type,
      @JsonAlias("initial-delay") String initialDelay,
      @JsonAlias("max-delay") String maxDelay,
      Double multiplier,
      Double jitter) {}

  @Builder
  public record ErrorStrategyManifest(String exception, ErrorStrategy strategy) {}

  @Builder
  public record ListenerItemManifest(String tool, Boolean async, Map<String, Object> input) {}

  public enum BackoffType {
    fixed,
    linear,
    exponential
  }

  public enum ErrorStrategy {
    retry,
    skip,
    stop,
    fallback
  }
}
