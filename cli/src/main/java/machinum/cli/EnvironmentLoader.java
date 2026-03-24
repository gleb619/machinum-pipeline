package machinum.cli;

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

/** Loads environment values from .env and .ENV files and makes them available to runtime. */
@Slf4j
@Builder
@AllArgsConstructor
public class EnvironmentLoader {

  @Builder.Default
  private Map<String, String> environment = new ConcurrentHashMap<>();

  /**
   * Loads environment from .env and .ENV files in the given directory. Missing files are logged and
   * skipped.
   */
  public EnvironmentLoader loadFromDirectory(Path dir) {
    loadEnvFile(dir.resolve(".env"));
    loadEnvFile(dir.resolve(".ENV"));
    return this;
  }

  /** Loads a single .env file. */
  private void loadEnvFile(Path path) {
    if (!Files.exists(path)) {
      log.debug("Env file not found (optional): {}", path);
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

  /** Gets an environment value by name. */
  public String get(String name) {
    return environment.get(name);
  }

  /** Gets an environment value with a default fallback. */
  public String get(String name, String defaultValue) {
    return environment.getOrDefault(name, defaultValue);
  }

  /** Returns all loaded environment variables. */
  public Map<String, String> getAll() {
    return new HashMap<>(environment);
  }

  /** Sets an environment variable. */
  public void set(String name, String value) {
    environment.put(name, value);
  }
}
