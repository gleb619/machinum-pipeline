package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import lombok.Builder;

@Builder
public record PipelineConfigManifest(
    @JsonAlias("batch") Integer batchSize,
    @JsonAlias("window") Integer windowBatchSize,
    String cooldown,
    @JsonAlias("override") Boolean allowOverrideMode,
    ManifestSnapshot snapshot) {

  public static PipelineConfigManifest empty() {
    return PipelineConfigManifest.builder()
        .batchSize(10)
        .windowBatchSize(5)
        .cooldown("5s")
        .allowOverrideMode(Boolean.TRUE)
        .snapshot(ManifestSnapshot.copy)
        .build();
  }

  public enum ManifestSnapshot {

    copy,
    reference,

  }

}
