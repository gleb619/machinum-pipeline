package machinum.manifest;

import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record PipelineManifest(
    String version,
    String type,
    String name,
    String description,
    @Singular Map<String, String> labels,
    @Singular("metadata") Map<String, String> metadata,
    PipelineBody body)
    implements Manifest {

  public static PipelineManifest empty() {
    return PipelineManifest.builder()
        .body(PipelineBody.empty())
        .build();
  }
}
