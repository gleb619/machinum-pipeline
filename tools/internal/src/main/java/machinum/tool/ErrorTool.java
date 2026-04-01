package machinum.tool;

import machinum.pipeline.ExecutionContext;

public class ErrorTool implements Tool {

  private static final ToolInfo INFO =
      new ToolInfo("errortool", "Always throws an exception for error handling tests");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    return ToolResult.failure("ErrorTool: forced error");
  }
}
