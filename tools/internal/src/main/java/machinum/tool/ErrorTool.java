package machinum.tool;

import machinum.pipeline.ExecutionContext;

public class ErrorTool implements InternalTool {

  private static final ToolInfo INFO =
      new ToolInfo("errortool", "internal", "Always throws an exception for error handling tests");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult process(ExecutionContext context) throws Exception {
    return ToolResult.failure("ErrorTool: forced error");
  }
}
