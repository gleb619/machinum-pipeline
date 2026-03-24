package machinum.tool;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import machinum.pipeline.ExecutionContext;
import machinum.yaml.ToolDefinition;

/** In-memory tool registry implementation for internal tool resolution. */
@Builder
@AllArgsConstructor
public class InMemoryToolRegistry implements ToolRegistry {

  @Builder.Default
  private Map<String, Tool> tools = new ConcurrentHashMap<>();

  @Override
  public void register(Tool tool) {
    tools.put(tool.definition().name(), tool);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    return Optional.ofNullable(tools.get(name));
  }

  @Override
  public boolean contains(String name) {
    return tools.containsKey(name);
  }

  /** Registers all tools from a tool definition list. */
  public void registerAll(List<ToolDefinition> definitions) {
    for (ToolDefinition def : definitions) {
      if (def.isInternal()) {
        register(new InternalTool(def));
      }
    }
  }

  /** Simple internal tool implementation. */
  @RequiredArgsConstructor
  private static class InternalTool implements Tool {
    private final ToolDefinition definition;

    @Override
    public ToolDefinition definition() {
      return definition;
    }

    @Override
    public ToolResult execute(ExecutionContext context) {
      Map<String, Object> outputs = new HashMap<>();
      outputs.put("tool", definition.name());
      outputs.put("type", definition.type());
      return ToolResult.success(outputs);
    }
  }
}
