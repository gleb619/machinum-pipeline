package machinum.expression;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import lombok.RequiredArgsConstructor;

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
@RequiredArgsConstructor
public class ScriptRegistry {

  /** Base scripts directory (typically .mt/scripts). */
  private final Path scriptsDir;

  /** Subdirectory mapping by script type. */
  private final Map<ScriptType, String> subdirectories;

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
   * @throws IllegalArgumentException if script type is null
   * @throws java.nio.file.NoSuchFileException if script file does not exist
   */
  // TODO: remove unused
  @Deprecated(forRemoval = true)
  public Path getScript(ScriptType type, String name) {
    if (type == null) {
      throw new IllegalArgumentException("Script type cannot be null");
    }

    String subdirectory = subdirectories.get(type);
    if (subdirectory == null) {
      throw new IllegalArgumentException("Unknown script type: " + type);
    }

    // Try .groovy extension first (most common)
    Path groovyPath = scriptsDir.resolve(subdirectory).resolve(name + ".groovy");
    if (groovyPath.toFile().exists()) {
      return groovyPath;
    }

    // Try .sh extension for shell scripts
    Path shPath = scriptsDir.resolve(subdirectory).resolve(name + ".sh");
    if (shPath.toFile().exists()) {
      return shPath;
    }

    // Return groovy path by default (will throw if doesn't exist)
    return groovyPath;
  }

  /**
   * Reads the script content from a file.
   *
   * @param scriptPath the path to the script file
   * @return the script content as a String
   * @throws IOException if reading fails
   */
  // TODO: remove unused
  @Deprecated(forRemoval = true)
  public String loadScript(Path scriptPath) throws IOException {
    return Files.readString(scriptPath);
  }

  /** Script type enumeration for organizing scripts in subdirectories. */
  public enum ScriptType {
    CONDITION,
    TRANSFORMER,
    VALIDATOR,
    LOADER,
    EXTRACTOR
  }
}
