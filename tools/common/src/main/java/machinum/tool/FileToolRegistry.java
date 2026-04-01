package machinum.tool;

import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;

@Slf4j
//TODO: Redo registry, check `BuiltInToolRegistry` and adapt it to work with the result jars. We need to load tool
// from jars and execute method `bootstrap`/`execute`. But do not add delegate, share logic between to classes instead.
@Deprecated(forRemoval = true)
//TODO: Check `HttpToolRegistry`, we need some setting, to with what file we should work, main one or one from cache
// folder
public class FileToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools = new ConcurrentHashMap<>();

  public FileToolRegistry() {
    discoverTools();
  }

  private void discoverTools() {
    ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class);
    int count = 0;

    for (Tool tool : loader) {
      try {
        register(tool);
        count++;
        log.debug("SPI discovered tool: {}", tool.info().name());
      } catch (Exception e) {
        log.error("Failed to register SPI tool: {}", tool.getClass().getName(), e);
      }
    }

    log.info("Discovered {} tools via SPI", count);
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
  public ToolResult execute(String name, ExecutionContext context) {
    //TODO: Reuse jar/spi call here from builtin registry
    return ToolRegistry.super.execute(name, context);
  }

  @Override
  public void bootstrapAll(BootstrapContext context) throws Exception {
    for (Tool tool : tools.values()) {
      String toolName = tool.info().name();
      log.info("Installing tool: {}", toolName);
      try {
        tool.bootstrap(context);
        log.info("Successfully installed tool: {}", toolName);
      } catch (Exception e) {
        log.error("Failed to bootstrap tool: {}", toolName, e);
        throw e;
      }
    }
  }
}
