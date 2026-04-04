package machinum.tool;

import java.util.Map;
import machinum.pipeline.ExecutionContext;

public class NoOpTool implements Tool {

  private static final ToolInfo INFO =
      new ToolInfo("nooptool", "No-operation tool for testing pipeline wiring");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    return ToolResult.success(context, Map.of());
  }
}
