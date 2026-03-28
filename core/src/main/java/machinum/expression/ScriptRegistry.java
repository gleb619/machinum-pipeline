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

@Slf4j
@RequiredArgsConstructor
public class ScriptRegistry {

  private final Path scriptsDir;

  private final Map<ScriptType, String> subdirectories = new ConcurrentHashMap<>();

  private final Map<Path, Script> compiledScripts = new ConcurrentHashMap<>();

  public ScriptRegistry init() {
    subdirectories.put(ScriptType.CONDITION, "conditions");
    subdirectories.put(ScriptType.TRANSFORMER, "transformers");
    subdirectories.put(ScriptType.VALIDATOR, "validators");
    subdirectories.put(ScriptType.LOADER, "loaders");
    subdirectories.put(ScriptType.EXTRACTOR, "extractors");

    return this;
  }

  public Path getScript(ScriptType type, String name) {
    if (type == null) {
      throw new IllegalArgumentException("Script type cannot be null");
    }

    String subdirectory = type.getDirectoryName();

    Path groovyPath = scriptsDir.resolve(subdirectory).resolve(name + ".groovy");
    if (Files.exists(groovyPath)) {
      return groovyPath;
    }

    Path shPath = scriptsDir.resolve(subdirectory).resolve(name + ".sh");
    if (Files.exists(shPath)) {
      return shPath;
    }

    return groovyPath;
  }

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
      throw new IllegalArgumentException("Invalid script type: %s. Valid types: %s"
          .formatted(typeName, String.join(", ", elements)));
    }

    return getScript(type, scriptName);
  }

  public String loadScript(Path scriptPath) throws IOException {
    return Files.readString(scriptPath);
  }

  @Deprecated(forRemoval = true)
  public Object executeScript(ScriptType type, String name, Binding binding) throws IOException {
    Path scriptPath = getScript(type, name);
    return executeScript(scriptPath, binding);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public Object executeScriptByDottedPath(String dottedPath, Binding binding) throws IOException {
    Path scriptPath = getScriptByDottedPath(dottedPath);
    return executeScript(scriptPath, binding);
  }

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

  public boolean exists() {
    return Files.exists(scriptsDir);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public boolean hasScript(ScriptType type, String name) {
    try {
      Path path = getScript(type, name);
      return Files.exists(path);
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

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

    public String getDirectoryName() {
      return directoryName;
    }

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
