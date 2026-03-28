package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import lombok.Builder;

@Builder
public record PipelineConfigManifest(
    @JsonAlias("batch-size") Integer batchSize,
    @JsonAlias("window-batch-size") Integer windowBatchSize,
    String cooldown,
    @JsonAlias("allow-override-mode") Boolean allowOverrideMode,
    PipelineExecution execution) {

  @Builder
  public record PipelineExecution(
      @JsonAlias("manifest-snapshot") ManifestSnapshotConfig manifestSnapshot,
      String mode,
      @JsonAlias("max-concurrency") Integer maxConcurrency) {}

  @Builder
  public record ManifestSnapshotConfig(Boolean enabled, String mode) {}
}
