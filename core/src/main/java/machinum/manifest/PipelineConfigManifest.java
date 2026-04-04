package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import lombok.Builder;

@Builder
public record PipelineConfigManifest(
    @JsonAlias("batch") Integer batchSize,
    @JsonAlias("window") Integer windowBatchSize,
    String cooldown,
    @JsonAlias("override") Boolean allowOverrideMode,
    PipelineExecution execution) {

  @Builder
  public record PipelineExecution(
      @JsonAlias("snapshot") ManifestSnapshotConfig manifestSnapshot,
      String mode,
      @JsonAlias("concurrency") Integer maxConcurrency) {}

  @Builder
  public record ManifestSnapshotConfig(Boolean enabled, String mode) {}
}
