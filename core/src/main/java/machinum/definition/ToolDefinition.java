package machinum.definition;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import machinum.compiler.Compiled;

@Builder
public record ToolDefinition(
    Compiled<String> name,
    Compiled<String> description,
    Compiled<String> type,
    Compiled<String> version,
    Compiled<String> executionTarget,
    Compiled<String> timeout,
    ToolSourceDefinition source,
    ToolCacheDefinition cache,
    ToolConfigDefinition config) {

  @Builder
  public record ToolSourceDefinition(
      String type, String url, String gitTag, String spiClass, String image) {}

  @Builder
  public record ToolCacheDefinition(Boolean enabled, String key, String ttl) {}

  @Builder
  public record ToolConfigDefinition(
      String model,
      Double temperature,
      Map<String, Object> inputSchema,
      Map<String, Object> outputSchema,
      List<String> args,
      String endpoint,
      String channel,
      String workDir) {}
}
