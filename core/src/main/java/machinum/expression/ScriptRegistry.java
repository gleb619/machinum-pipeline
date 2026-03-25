package machinum.expression;

import groovy.lang.Binding;
import groovy.lang.GroovyShell;
import groovy.lang.Script;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.codehaus.groovy.control.CompilerConfiguration;

/**
 * Locates and loads scripts by type and name from the workspace scripts directory.
 *
 * <p>Script types and their subdirectories:
 *
 * <ul>
 *   <li>CONDITION → conditions/
 *   <li>TRANSFORMER → transformers/
 *   <li>VALIDATOR → validators/
 *   <li>LOADER → loaders/
 *   <li>EXTRACTOR → extractors/
 * </ul>
 */
@Slf4j
@RequiredArgsConstructor
public class ScriptRegistry {

  /** Base scripts directory (typically .mt/scripts). */
  private final Path scriptsDir;

  /** Subdirectory mapping by script type. */
  private final Map<ScriptType, String> subdirectories = new ConcurrentHashMap<>();

  /** Compiled script cache for performance. */
  private final Map<Path, Script> compiledScripts = new ConcurrentHashMap<>();

  /**
   * Initializes the script registry with default subdirectory mappings.
   *
   * @return this registry instance
   */
  public ScriptRegistry init() {
    subdirectories.put(ScriptType.CONDITION, "conditions");
    subdirectories.put(ScriptType.TRANSFORMER, "transformers");
    subdirectories.put(ScriptType.VALIDATOR, "validators");
    subdirectories.put(ScriptType.LOADER, "loaders");
    subdirectories.put(ScriptType.EXTRACTOR, "extractors");

    return this;
  }

  /**
   * Resolves the script path by type and name.
   *
   * @param type the script type
   * @param name the script name (without extension)
   * @return the absolute path to the script file
   * @throws IllegalArgumentException if script type is null or unknown
   * @throws java.nio.file.NoSuchFileException if script file does not exist
   */
  public Path getScript(ScriptType type, String name) {
    if (type == null) {
      throw new IllegalArgumentException("Script type cannot be null");
    }

    String subdirectory = type.getDirectoryName();

    // Try .groovy extension first (most common)
    Path groovyPath = scriptsDir.resolve(subdirectory).resolve(name + ".groovy");
    if (Files.exists(groovyPath)) {
      return groovyPath;
    }

    // Try .sh extension for shell scripts
    Path shPath = scriptsDir.resolve(subdirectory).resolve(name + ".sh");
    if (Files.exists(shPath)) {
      return shPath;
    }

    // Return groovy path by default (will throw if doesn't exist)
    return groovyPath;
  }

  /**
   * Resolves a script path from a dotted notation (e.g., "conditions.should_clean").
   *
   * @param dottedPath dotted path like "conditions.should_clean" or "transformers.normalize"
   * @return the absolute path to the script file
   * @throws IllegalArgumentException if path format is invalid
   * @throws java.nio.file.NoSuchFileException if script file does not exist
   */
  public Path getScriptByDottedPath(String dottedPath) {
    if (dottedPath == null || dottedPath.isBlank()) {
      throw new IllegalArgumentException("Script path cannot be null or blank");
    }

    String[] parts = dottedPath.split("\\.", 2);
    if (parts.length != 2) {
      throw new IllegalArgumentException("Invalid script path format: " + dottedPath
          + ". Expected: type.name (e.g., conditions.should_clean)");
    }

    String typeName = parts[0];
    String scriptName = parts[1];

    ScriptType type = ScriptType.fromDirectoryName(typeName);
    if (type == null) {
      String[] elements = Arrays.stream(ScriptType.values())
          .map(ScriptType::getDirectoryName)
          .toArray(String[]::new);
      throw new IllegalArgumentException(
          "Invalid script type: %s. Valid types: %s".formatted(
              typeName, String.join(", ", elements)));
    }

    return getScript(type, scriptName);
  }

  /**
   * Reads the script content from a file.
   *
   * @param scriptPath the path to the script file
   * @return the script content as a String
   * @throws IOException if reading fails
   */
  public String loadScript(Path scriptPath) throws IOException {
    return Files.readString(scriptPath);
  }

  /**
   * Executes a script by type and name with the given binding.
   *
   * @param type the script type
   * @param name the script name
   * @param binding the Groovy binding with context variables
   * @return the script execution result
   * @throws IOException if script loading fails
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Object executeScript(ScriptType type, String name, Binding binding) throws IOException {
    Path scriptPath = getScript(type, name);
    return executeScript(scriptPath, binding);
  }

  /**
   * Executes a script from a dotted path with the given binding.
   *
   * @param dottedPath dotted path like "conditions.should_clean"
   * @param binding the Groovy binding with context variables
   * @return the script execution result
   * @throws IOException if script loading fails
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Object executeScriptByDottedPath(String dottedPath, Binding binding) throws IOException {
    Path scriptPath = getScriptByDottedPath(dottedPath);
    return executeScript(scriptPath, binding);
  }

  /**
   * Executes a script file with the given binding. Uses caching for compiled scripts.
   *
   * @param scriptPath the path to the script file
   * @param binding the Groovy binding with context variables
   * @return the script execution result
   * @throws IOException if script loading fails
   */
  private Object executeScript(Path scriptPath, Binding binding) throws IOException {
    Script script = compiledScripts.computeIfAbsent(scriptPath, path -> {
      try {
        String scriptText = Files.readString(path);
        CompilerConfiguration config = new CompilerConfiguration();
        GroovyShell shell = new GroovyShell(config);
        return shell.parse(scriptText);
      } catch (IOException e) {
        throw new RuntimeException("Failed to compile script: " + path, e);
      }
    });

    script.setBinding(binding);
    log.debug("Executing script: {}", scriptPath);
    return script.run();
  }

  /**
   * Checks if the scripts directory exists.
   *
   * @return true if scripts directory exists
   */
  public boolean exists() {
    return Files.exists(scriptsDir);
  }

  /**
   * Checks if a specific script exists.
   *
   * @param type the script type
   * @param name the script name
   * @return true if the script file exists
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public boolean hasScript(ScriptType type, String name) {
    try {
      Path path = getScript(type, name);
      return Files.exists(path);
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  /** Script type enumeration for organizing scripts in subdirectories. */
  public enum ScriptType {
    CONDITION("conditions"),
    TRANSFORMER("transformers"),
    VALIDATOR("validators"),
    LOADER("loaders"),
    EXTRACTOR("extractors");

    private final String directoryName;

    ScriptType(String directoryName) {
      this.directoryName = directoryName;
    }

    /**
     * Gets the directory name for this script type.
     *
     * @return the directory name (e.g., "conditions", "transformers")
     */
    public String getDirectoryName() {
      return directoryName;
    }

    /**
     * Finds a ScriptType by its directory name.
     *
     * @param directoryName the directory name (e.g., "conditions")
     * @return the matching ScriptType, or null if not found
     */
    public static ScriptType fromDirectoryName(String directoryName) {
      for (ScriptType type : values()) {
        if (type.directoryName.equalsIgnoreCase(directoryName)) {
          return type;
        }
      }
      return null;
    }
  }
}
