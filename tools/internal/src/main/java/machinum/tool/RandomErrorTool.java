package machinum.tool;

import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;

@Slf4j
public class RandomErrorTool implements Tool {

  private static final ToolInfo INFO =
      new ToolInfo("randerrortool", "Throws an exception randomly based on threshold config");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    double threshold = 0.5;
    double roll = Math.random();

    log.debug("RandomErrorTool: roll={}, threshold={}", roll, threshold);

    if (roll < threshold) {
      return ToolResult.failure(
          context,
          "RandomErrorTool: random failure (roll=%.4f < threshold=%.4f)"
              .formatted(roll, threshold));
    }

    return ToolResult.success(context, Map.of("roll", roll, "threshold", threshold));
  }
}
