package machinum;

import java.util.Map;
import lombok.Builder;
import machinum.manifest.ToolManifestDepricated;
import machinum.pipeline.ExecutionContext;

public interface Tool {

  ToolManifestDepricated definition();

  ToolResult execute(ExecutionContext context) throws Exception;

  default void validate() {}

  @Builder
  record ToolResult(boolean success, Map<String, Object> outputs, String errorMessage) {

    public static ToolResult success(Map<String, Object> outputs) {
      return new ToolResult(Boolean.TRUE, outputs, null);
    }

    public static ToolResult failure(String errorMessage) {
      return new ToolResult(Boolean.FALSE, null, errorMessage);
    }
  }
}
