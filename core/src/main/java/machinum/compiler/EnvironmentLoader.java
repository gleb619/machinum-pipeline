package machinum.compiler;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@Builder
@AllArgsConstructor
public class EnvironmentLoader {

  @Builder.Default
  private Map<String, String> environment = new ConcurrentHashMap<>();

  public EnvironmentLoader loadFromDirectory(Path dir) {
    return loadFromPaths(
      dir.resolve(".env"),
      dir.resolve(".ENV")
    );
  }

  public EnvironmentLoader loadFromPaths(Path... paths) {
    for (Path path : paths) {
      loadEnvFile(path);
    }
    return this;
  }

  void loadEnvFile(Path path) {
    if (!Files.exists(path)) {
      log.trace("Env file not found (optional): {}", path);
      return;
    }

    try {
      Properties props = new Properties();
      try (var reader = Files.newBufferedReader(path)) {
        props.load(reader);
      }

      for (String key : props.stringPropertyNames()) {
        String value = props.getProperty(key);
        environment.put(key, value);
        log.debug("Loaded env: {}={}", key, value);
      }

      log.info("Loaded environment from: {}", path);
    } catch (IOException e) {
      log.warn("Failed to load env file: {}", path, e);
    }
  }

  public String get(String name) {
    return environment.get(name);
  }

  public String get(String name, String defaultValue) {
    return environment.getOrDefault(name, defaultValue);
  }

  public Map<String, String> getAll() {
    return new HashMap<>(environment);
  }

}
