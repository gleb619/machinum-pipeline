package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.PipelineBody.ErrorHandlingManifest;
import machinum.manifest.PipelineConfigManifest.ManifestSnapshotConfig;

@Builder
public record RootBody(
    @Singular Map<String, String> variables,
    RootExecutionManifest execution,
    @JsonAlias("error-handling") ErrorHandlingManifest errorHandling,
    @JsonAlias("pipeline-config") PipelineConfigManifest config,
    RootCleanupManifest cleanup,
    @JsonAlias("env-files") @Singular List<String> envFiles,
    @Singular("env") Map<String, String> env)
    implements ManifestBody {

  @Builder
  public record RootExecutionManifest(
      Boolean parallel,
      @JsonAlias("max-concurrency") Integer maxConcurrency,
      @JsonAlias("manifest-snapshot") ManifestSnapshotConfig manifestSnapshot) {}

  @Builder
  public record RootCleanupManifest(
      String success,
      String failed,
      @JsonAlias("success-runs") String successRuns,
      @JsonAlias("failed-runs") String failedRuns) {}
}
