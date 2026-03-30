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
    @Singular List<PipelineToolDefinition> stateTools) {

  @Builder
  public record PipelineToolDefinition(
      Compiled<String> name,
      Compiled<String> description,
      Compiled<Boolean> async,
      Compiled<String> input,
      Compiled<String> output,
      @Singular List<PipelineToolDefinition> tools) {}
}
