package machinum.yaml;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.RequiredArgsConstructor;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.representer.Representer;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * Loads and validates YAML manifests with strict schema enforcement. Fails fast on ambiguous or
 * invalid configuration.
 */
@Builder
@RequiredArgsConstructor
public class YamlManifestLoader {

  private final ObjectMapper objectMapper;
  private final Yaml yaml;

  public static YamlManifestLoader of() {
    LoaderOptions loaderOptions = new LoaderOptions();
    loaderOptions.setMaxAliasesForCollections(50);
    loaderOptions.setAllowDuplicateKeys(false);
    var yaml = new Yaml(new SafeConstructor(loaderOptions), new Representer(new DumperOptions()));
    return YamlManifestLoader.builder()
        .objectMapper(JsonMapper.builder()
            .findAndAddModules()
            .build())
        .yaml(yaml)
        .build();
  }

  /** Loads and validates a root manifest from the given path. */
  public RootManifest loadRootManifest(Path path) throws IOException {
    try (InputStream is = Files.newInputStream(path)) {
      Map<String, Object> raw = yaml.load(is);
      if (raw == null) {
        throw new ValidationException("Root manifest is empty: " + path);
      }
      validateRootManifest(raw, path);
      return objectMapper.convertValue(raw, RootManifest.class);
    }
  }

  /** Loads and validates a tools manifest from the given path. */
  public ToolsManifest loadToolsManifest(Path path) throws IOException {
    try (InputStream is = Files.newInputStream(path)) {
      Map<String, Object> raw = yaml.load(is);
      if (raw == null) {
        throw new ValidationException("Tools manifest is empty: " + path);
      }
      validateToolsManifest(raw, path);
      return objectMapper.convertValue(raw, ToolsManifest.class);
    }
  }

  /** Loads and validates a pipeline manifest from the given path. */
  public PipelineManifest loadPipelineManifest(Path path) throws IOException {
    try (InputStream is = Files.newInputStream(path)) {
      Map<String, Object> raw = yaml.load(is);
      if (raw == null) {
        throw new ValidationException("Pipeline manifest is empty: " + path);
      }
      validatePipelineManifest(raw, path);
      return objectMapper.convertValue(raw, PipelineManifest.class);
    }
  }

  /** Loads a generic YAML file as a map. */
  @SuppressWarnings("unchecked")
  public Map<String, Object> loadYaml(Path path) throws IOException {
    try (InputStream is = Files.newInputStream(path)) {
      return yaml.load(is);
    }
  }

  private void validateRootManifest(Map<String, Object> raw, Path path) {
    List<String> errors = new ArrayList<>();

    if (!raw.containsKey("name")) {
      errors.add("Missing required field: name");
    }
    if (!raw.containsKey("version")) {
      errors.add("Missing required field: version");
    }

    if (!errors.isEmpty()) {
      throw new ValidationException(
          "Root manifest validation failed at %s: %s".formatted(path, String.join(", ", errors)));
    }
  }

  private void validateToolsManifest(Map<String, Object> raw, Path path) {
    List<String> errors = new ArrayList<>();

    if (!raw.containsKey("name")) {
      errors.add("Missing required field: name");
    }
    if (!raw.containsKey("tools")) {
      errors.add("Missing required field: tools");
    } else if (!(raw.get("tools") instanceof List)) {
      errors.add("Field 'tools' must be a list");
    }

    if (!errors.isEmpty()) {
      throw new ValidationException(
          "Tools manifest validation failed at %s: %s".formatted(path, String.join(", ", errors)));
    }
  }

  private void validatePipelineManifest(Map<String, Object> raw, Path path) {
    List<String> errors = new ArrayList<>();

    if (!raw.containsKey("name")) {
      errors.add("Missing required field: name");
    }
    if (!raw.containsKey("states")) {
      errors.add("Missing required field: states");
    } else if (!(raw.get("states") instanceof List)) {
      errors.add("Field 'states' must be a list");
    }

    // Validate source/items constraint
    boolean hasSource = raw.containsKey("source");
    boolean hasItems = raw.containsKey("items");

    if (hasSource && hasItems) {
      errors.add("Exactly one of 'source' or 'items' must be declared, not both");
    } else if (!hasSource && !hasItems) {
      errors.add("Exactly one of 'source' or 'items' must be declared");
    }

    if (!errors.isEmpty()) {
      throw new ValidationException(
          "Pipeline manifest validation failed at %s: %s".formatted(path, String.join(", ", errors)));
    }

    // Validate states
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> states = (List<Map<String, Object>>) raw.get("states");
    if (states != null) {
      for (int i = 0; i < states.size(); i++) {
        Map<String, Object> state = states.get(i);
        if (!state.containsKey("name")) {
          errors.add("State at index %d is missing required field: name".formatted(i));
        }
        if (!state.containsKey("tools")) {
          errors.add("State '%s' is missing required field: tools".formatted(state.get("name")));
        }
      }
    }

    if (!errors.isEmpty()) {
      throw new ValidationException(
          "Pipeline manifest validation failed at %s: %s".formatted(path, String.join(", ", errors)));
    }
  }

  /** Exception thrown when manifest validation fails. */
  public static class ValidationException extends RuntimeException {
    public ValidationException(String message) {
      super(message);
    }
  }
}
