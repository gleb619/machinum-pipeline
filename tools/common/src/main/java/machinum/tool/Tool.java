package machinum.tool;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;

public interface Tool {

  ToolInfo info();

  default ToolResult execute(ExecutionContext context) {
    return ToolResult.empty();
  }

  default void bootstrap(BootstrapContext context) {
    validate();
  }

  default void afterBootstrap(BootstrapContext context) {
    // No-op by default
  }

  default void validate() {
    // No-op by default
  }

  default List<String> dependsOn() {
    return List.of();
  }

  default int priority() {
    return -1;
  }

  @Builder
  record ToolResult(boolean success, Map<String, Object> outputs, String errorMessage) {

    public static ToolResult empty() {
      return success(Map.of());
    }

    public static ToolResult success(Map<String, Object> outputs) {
      return new ToolResult(Boolean.TRUE, outputs, null);
    }

    public static ToolResult failure(String errorMessage) {
      return failure(errorMessage, Map.of());
    }

    public static ToolResult failure(String errorMessage, Map<String, Object> outputs) {
      return new ToolResult(Boolean.FALSE, outputs, errorMessage);
    }
  }
}
