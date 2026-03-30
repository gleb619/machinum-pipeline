package machinum.tool;

import machinum.Tool;
import machinum.pipeline.ExecutionContext;

public interface InternalTool extends Tool {

  default void install(ExecutionContext context) throws Exception {
    // No-op by default
  }

  ToolResult process(ExecutionContext context) throws Exception;

  @Override
  default ToolResult execute(ExecutionContext context) throws Exception {
    return process(context);
  }
}
