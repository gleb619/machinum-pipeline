package machinum.tool;

import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;

@Slf4j
public class TestTool implements InternalTool {

  private static final ToolInfo INFO =
      new ToolInfo("testtool", "internal", "Transforms input and returns modified content");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult process(ExecutionContext context) throws Exception {
    Object input = context.get("input", "");
    String inputStr = input.toString();
    String output = inputStr + " [processed-by-testtool]";

    log.debug("TestTool: input='{}' -> output='{}'", inputStr, output);

    return ToolResult.success(Map.of("input", inputStr, "output", output));
  }
}
