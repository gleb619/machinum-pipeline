package machinum.tool;

import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;

@Slf4j
public class TestTool implements Tool {

  private static final ToolInfo INFO =
      new ToolInfo("testtool", "Transforms input and returns modified content");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public void bootstrap(BootstrapContext context) {
    log.debug("TestTool: Bootstrap called: {}", context);
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    Object input = context.get("input", "");
    String inputStr = input.toString();
    String output = inputStr + " [processed-by-testtool]";

    log.debug("TestTool: input='{}' -> output='{}'", inputStr, output);

    return ToolResult.success(context, Map.of("input", inputStr, "output", output));
  }
}
