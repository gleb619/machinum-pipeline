package machinum.definition;

import java.util.Map;
import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;

@Builder
public record ToolDefinition(
    Compiled<String> name, Compiled<String> description, ToolConfigDefinition config) {

  @Builder
  public record ToolConfigDefinition(
      Map<String, Object> inputSchema,
      Map<String, Object> outputSchema,
      CompiledMap<Object> params) {}
}
