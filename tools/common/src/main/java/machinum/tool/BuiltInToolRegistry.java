package machinum.tool;

import java.util.ArrayList;
import java.util.List;
import java.util.ServiceLoader;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public class BuiltInToolRegistry extends AbstractJarToolRegistry {

  public BuiltInToolRegistry init() {
    loadToolsFromClasspath();
    if (tools.isEmpty()) {
      log.warn("No tools found on classpath, scanning Gradle build output...");
    }

    if (tools.isEmpty()) {
      log.warn("No built-in tools loaded. Ensure -PbuiltinToolsEnabled is set or tools are built.");
    } else {
      log.info(
          "BuiltInToolRegistry initialized with {} tools: {}",
          tools.size(),
          String.join(", ", tools.keySet()));
    }

    return this;
  }

  private void loadToolsFromClasspath() {
    ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class);
    List<String> names = new ArrayList<>();
    for (Tool tool : loader) {
      try {
        register(tool);
        names.add(tool.info().name());
      } catch (Exception e) {
        log.error("Failed to register tool from classpath: {}", tool.info().name(), e);
      }
    }
    log.debug("Loaded tools from classpath: ({}) {}", names.size(), names);
  }
}
