package machinum.tool;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;

@Slf4j
@RequiredArgsConstructor
public class BuiltInToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools = new ConcurrentHashMap<>();
  //TODO: Override method `ToolRegistry#execute` and use classLoaders there
  @Deprecated(forRemoval = true)
  private final List<URLClassLoader> classLoaders = new ArrayList<>();
  private final Path toolsDirectory;

  public BuiltInToolRegistry init() {
    loadToolsFromJars();

    return this;
  }

  private void loadToolsFromJars() {
    if (!Files.exists(toolsDirectory)) {
      log.debug("Tools directory does not exist: {}", toolsDirectory);
      return;
    }

    try {
      Files.list(toolsDirectory)
          .filter(path -> path.toString().endsWith(".jar"))
          .forEach(this::loadJar);
    } catch (IOException e) {
      log.error("Failed to list tools directory: {}", toolsDirectory, e);
    }
  }

  private void loadJar(Path jarPath) {
    try {
      URL jarUrl = jarPath.toUri().toURL();
      URLClassLoader classLoader =
          new URLClassLoader(new URL[] {jarUrl}, BuiltInToolRegistry.class.getClassLoader());
      classLoaders.add(classLoader);

      ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class, classLoader);
      int count = 0;

      for (Tool tool : loader) {
        try {
          register(tool);
          count++;
          log.info("Loaded tool '{}' from JAR: {}", tool.info().name(), jarPath.getFileName());
        } catch (Exception e) {
          log.error("Failed to register tool from JAR: {}", jarPath, e);
        }
      }

      if (count > 0) {
        log.info("Loaded {} tools from JAR: {}", count, jarPath.getFileName());
      }
    } catch (MalformedURLException e) {
      log.error("Failed to load JAR: {}", jarPath, e);
    }
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
    //TODO: Call jar/spi here
    return ToolRegistry.super.execute(name, context);
  }

  @Override
  public void bootstrapAll(BootstrapContext context) {
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
