package machinum.tool;

import java.util.Map;
import machinum.pipeline.ExecutionContext;

public class NoOpTool implements InternalTool {

  private static final ToolInfo INFO =
      new ToolInfo("nooptool", "internal", "No-operation tool for testing pipeline wiring");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult process(ExecutionContext context) throws Exception {
    return ToolResult.success(Map.of());
  }
}
