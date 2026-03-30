package machinum.tool;

import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import machinum.Tool;
import machinum.ToolRegistry;
import machinum.pipeline.ExecutionContext;

@Slf4j
public class SpiToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools = new ConcurrentHashMap<>();

  public SpiToolRegistry() {
    discoverInternalTools();
  }

  private void discoverInternalTools() {
    ServiceLoader<InternalTool> loader = ServiceLoader.load(InternalTool.class);
    int count = 0;

    for (InternalTool tool : loader) {
      try {
        register(tool);
        count++;
        log.debug("SPI discovered internal tool: {}", tool.info().name());
      } catch (Exception e) {
        log.error("Failed to register SPI tool: {}", tool.getClass().getName(), e);
      }
    }

    log.info("Discovered {} internal tools via SPI", count);
  }

  @Override
  public void register(Tool tool) {
    String name = tool.info().name();
    tools.put(name, tool);
    log.debug("Registered tool: {}", name);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    Tool tool = tools.get(name);
    if (tool != null) {
      return Optional.of(tool);
    }
    log.debug("Tool not found: {}", name);
    return Optional.empty();
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

  public void installAll(ExecutionContext context) throws Exception {
    for (Tool tool : tools.values()) {
      if (tool instanceof InternalTool internalTool) {
        String toolName = internalTool.info().name();
        log.info("Installing internal tool: {}", toolName);
        try {
          internalTool.install(context);
          log.info("Successfully installed tool: {}", toolName);
        } catch (Exception e) {
          log.error("Failed to install tool: {}", toolName, e);
          throw e;
        }
      }
    }
  }

  public void clear() {
    tools.clear();
  }
}
