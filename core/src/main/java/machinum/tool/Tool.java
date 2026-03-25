package machinum.tool;

import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.pipeline.ExecutionContext;
import machinum.yaml.ToolDefinition;

/** Represents a tool that can be executed during pipeline processing. */
public interface Tool {

  /** Returns the tool definition. */
  ToolDefinition definition();

  /**
   * Executes the tool with the given itemContext.
   *
   * @param context the execution itemContext
   * @return the result of tool execution
   * @throws Exception if tool execution fails
   */
  ToolResult execute(ExecutionContext context) throws Exception;

  /** Result of a tool execution. */
  @Builder
  record ToolResult(boolean success, @Singular Map<String, Object> outputs, String errorMessage) {

    public static ToolResult success(Map<String, Object> outputs) {
      return ToolResult.builder().success(Boolean.TRUE).outputs(outputs).build();
    }

    public static ToolResult failure(String errorMessage) {
      return ToolResult.builder()
          .success(Boolean.FALSE)
          .errorMessage(errorMessage)
          .build();
    }
  }
}
