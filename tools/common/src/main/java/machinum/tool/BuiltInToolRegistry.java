package machinum.tool;

import java.util.ServiceLoader;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public class BuiltInToolRegistry extends AbstractJarToolRegistry {

  public BuiltInToolRegistry init() {
    int classpathTools = loadToolsFromClasspath();
    log.info("Loaded {} tools from classpath", classpathTools);

    if (tools.isEmpty()) {
      log.info("No tools found on classpath, scanning Gradle build output...");
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

  private int loadToolsFromClasspath() {
    int count = 0;
    ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class);
    for (Tool tool : loader) {
      try {
        register(tool);
        count++;
        log.debug("Loaded tool '{}' from classpath", tool.info().name());
      } catch (Exception e) {
        log.error("Failed to register tool from classpath: {}", tool.info().name(), e);
      }
    }
    return count;
  }
}
