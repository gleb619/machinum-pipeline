package machinum.definition;

import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;

@Builder
public record PipelineStateDefinition(
    Compiled<String> name,
    Compiled<String> description,
    Compiled<String> condition,
    Compiled<String> waitFor,
    WindowDefinition window,
    ForkDefinition fork,
    @Singular List<PipelineToolDefinition> tools) {

  @Builder
  public record PipelineToolDefinition(
      Compiled<String> name,
      Compiled<String> description,
      Compiled<Boolean> async,
      Compiled<String> input,
      Compiled<String> output,
      @Singular List<PipelineToolDefinition> tools) {}

  @Builder
  public record WindowDefinition(
      Compiled<String> type, Compiled<String> size, WindowAggregationDefinition aggregation) {}

  @Builder
  public record WindowAggregationDefinition(
      Compiled<String> groupBy,
      @Singular List<PipelineToolDefinition> tools,
      Compiled<String> output) {}

  @Builder
  public record ForkDefinition(@Singular List<ForkBranchDefinition> branches) {}

  @Builder
  public record ForkBranchDefinition(
      Compiled<String> name, @Singular List<PipelineStateDefinition> states) {}
}
