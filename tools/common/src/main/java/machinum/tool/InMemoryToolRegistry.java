package machinum.tool;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import machinum.Tool;
import machinum.ToolRegistry;

@Slf4j
//TODO: Unused
@Deprecated(forRemoval = true)
public class InMemoryToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools = new ConcurrentHashMap<>();

  public InMemoryToolRegistry() {}

  @Override
  public void register(Tool tool) {
    String name = tool.info().name();
    tools.put(name, tool);
    log.debug("Registered tool: {}", name);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    return Optional.ofNullable(tools.get(name));
  }

  @Override
  public boolean contains(String name) {
    return tools.containsKey(name);
  }

  public Map<String, Tool> getAllTools() {
    return Map.copyOf(tools);
  }

  public int size() {
    return tools.size();
  }

  public void clear() {
    tools.clear();
  }
}
