package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.PipelineBody.FallbackManifest;

@Builder
public record RootBody(
    @Singular Map<String, String> variables,
    RootExecutionManifest execution,
    FallbackManifest fallback,
    @JsonAlias("config") PipelineConfigManifest pipelineConfig,
    RootCleanupManifest cleanup,
    @JsonAlias("secrets") @Singular List<String> envFiles,
    @Singular("env") Map<String, String> env)
    implements ManifestBody {

  public static RootBody empty() {
    return RootBody.builder()
        .variables(Collections.emptyMap())
        .execution(RootExecutionManifest.empty())
        .fallback(FallbackManifest.empty())
        .pipelineConfig(PipelineConfigManifest.empty())
        .cleanup(RootCleanupManifest.empty())
        .build();
  }

  @Builder
  public record RootExecutionManifest(
      Boolean parallel,
      @JsonAlias("concurrency") Integer maxConcurrency) {

    public static RootExecutionManifest empty() {
      return RootExecutionManifest.builder()
          .parallel(Boolean.FALSE)
          .maxConcurrency(Math.max(Runtime.getRuntime().availableProcessors(), 4))
          .build();
    }
  }

  @Builder
  public record RootCleanupManifest(
      String pass,
      String fail,
      @JsonAlias("passes") String successRuns,
      @JsonAlias("fails") String failedRuns) {

    public static RootCleanupManifest empty() {
      return RootCleanupManifest.builder()
          .pass("5d")
          .fail("7d")
          .successRuns("10")
          .failedRuns("5")
          .build();
    }
  }
}
