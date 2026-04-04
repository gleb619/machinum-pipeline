package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Collections;
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
    @Singular List<PipelineToolManifest> tools,
    @Singular Map<PipelineLifecycleEvent, List<ListenerItemManifest>> listeners,
    FallbackManifest fallback)
    implements ManifestBody {

  public static PipelineBody empty() {
    return PipelineBody.builder()
        .source(SourceManifest.empty())
        .items(ItemsManifest.empty())
        .variables(Collections.emptyMap())
        .states(Collections.emptyList())
        .tools(Collections.emptyList())
        .listeners(Collections.emptyMap())
        .build();
  }

  @Builder
  public record FallbackManifest(
      @JsonAlias("default") String defaultStrategy,
      @JsonAlias("retry") RetryManifest retryConfig,
      @Singular List<ErrorStrategyManifest> strategies) {}

  @Builder
  public record RetryManifest(@JsonAlias("max") Integer maxAttempts, BackoffManifest backoff) {}

  @Builder
  public record BackoffManifest(
      BackoffType type,
      @JsonAlias("start") String initialDelay,
      @JsonAlias("max") String maxDelay,
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
