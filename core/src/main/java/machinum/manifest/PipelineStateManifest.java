package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
public record PipelineStateManifest(
    String name,
    String description,
    String condition,
    @JsonAlias("wait-for") String waitFor,
    WindowManifest window,
    ForkManifest fork,
    @Singular List<PipelineToolManifest> tools) {

  @Builder
  public record WindowManifest(String type, String size, WindowAggregationManifest aggregation) {}

  @Builder
  public record WindowAggregationManifest(
      @JsonAlias("group-by") String groupBy,
      @Singular List<PipelineToolManifest> tools,
      String output) {}

  @Builder
  public record ForkManifest(@Singular List<ForkBranchManifest> branches) {}

  @Builder
  public record ForkBranchManifest(String name, @Singular List<PipelineStateManifest> states) {}
}
