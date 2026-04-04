package machinum.tool;

import java.util.List;
import java.util.Map;
import lombok.Builder;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;

public interface Tool {

  ToolInfo info();

  default ToolResult execute(ExecutionContext context) {
    return ToolResult.empty(context);
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
  record ToolResult(
      ExecutionContext context, boolean success, Map<String, Object> outputs, String errorMessage) {

    public static ToolResult empty(ExecutionContext ctx) {
      return success(ctx, Map.of());
    }

    public static ToolResult success(ExecutionContext ctx, Map<String, Object> outputs) {
      return new ToolResult(ctx, Boolean.TRUE, outputs, null);
    }

    public static ToolResult failure(ExecutionContext ctx, String errorMessage) {
      return failure(ctx, errorMessage, Map.of());
    }

    public static ToolResult failure(
        ExecutionContext ctx, String errorMessage, Map<String, Object> outputs) {
      return new ToolResult(ctx, Boolean.FALSE, outputs, errorMessage);
    }
  }
}
