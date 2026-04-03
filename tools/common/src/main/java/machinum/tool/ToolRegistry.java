package machinum.tool;

import java.util.List;
import java.util.Optional;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;

public interface ToolRegistry {

  void register(Tool tool);

  Optional<Tool> resolve(String name);

  default ToolResult execute(String name, ExecutionContext context) {
    return resolve(name)
        .map(tool -> tool.execute(context))
        .orElseThrow(() -> new IllegalStateException("Tool not found: %s".formatted(name)));
  }

  void bootstrapAll(BootstrapContext context, List<String> targetTools) throws Exception;

  void afterBootstrapAll(BootstrapContext context, List<String> targetTools)
      throws Exception;
}
