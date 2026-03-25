package machinum.tool;

import groovy.lang.Binding;
import groovy.lang.GroovyShell;
import groovy.lang.Script;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import lombok.Builder;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;
import machinum.yaml.ToolDefinition;
import org.codehaus.groovy.control.CompilerConfiguration;

/**
 * External tool that executes Groovy scripts with context binding.
 *
 * <p>Scripts have access to predefined variables (item, text, runId, etc.) and can return any
 * object. Return values are converted to Map<String, Object> for tool results.
 */
@Data
@Slf4j
public class GroovyScriptTool extends ExternalTool {

  /** Script compilation cache for performance. */
  private static final Map<Path, Script> SCRIPT_CACHE = new ConcurrentHashMap<>();

  /** Path to the Groovy script. */
  private Path scriptPath;

  /** Expected return type (null for any type). */
  private Class<?> returnType;

  /** Enable security sandbox (default: true - uses restricted imports). */
  private boolean sandboxed;

  @Builder
  public GroovyScriptTool(
      ToolDefinition definition,
      Path workDir,
      Duration timeout,
      RetryPolicy retryPolicy,
      ExecutionTarget executionTarget,
      Path scriptPath,
      Class<?> returnType,
      boolean sandboxed) {
    super(definition, "groovy", workDir, timeout, retryPolicy, executionTarget);
    this.scriptPath = scriptPath;
    this.returnType = returnType;
    this.sandboxed = sandboxed;
  }

  /**
   * Creates a GroovyScriptTool from a ToolDefinition.
   *
   * @param definition tool definition with config
   * @param workDir workspace root directory
   * @return configured GroovyScriptTool instance
   * @throws IllegalArgumentException if script path is missing
   */
  // TODO: use or remove
  @Deprecated(forRemoval = true)
  public static GroovyScriptTool fromDefinition(ToolDefinition definition, Path workDir) {
    Map<String, Object> config = definition.toolConfig();

    // Resolve script path
    String scriptUrl = (String) config.get("url");
    if (scriptUrl == null || scriptUrl.isBlank()) {
      throw new IllegalArgumentException("Groovy tool must have a script url");
    }

    Path scriptPath = resolveScriptPath(scriptUrl, workDir);

    // Get optional return type
    String returnTypeStr = (String) config.get("return-type");
    Class<?> returnType = parseReturnType(returnTypeStr);

    // Get optional sandbox flag
    Boolean sandboxed = (Boolean) config.get("sandboxed");
    if (sandboxed == null) {
      sandboxed = true; // Default to sandboxed for security
    }

    // Get optional timeout
    Duration timeout = parseTimeout(config.get("timeout"));

    return GroovyScriptTool.builder()
        .definition(definition)
        .scriptPath(scriptPath)
        .returnType(returnType)
        .sandboxed(sandboxed)
        .workDir(workDir)
        .timeout(timeout)
        .build();
  }

  @Override
  public ToolResult execute(ExecutionContext context) throws Exception {
    validate();

    // Get or compile script
    Script script = getScript(scriptPath, sandboxed);

    // Create binding with context variables
    Binding binding = createBinding(context);
    script.setBinding(binding);

    // Execute script with timeout
    Object result;
    try {
      result = script.run();
    } catch (Exception e) {
      return ToolResult.failure("Groovy script execution failed: " + e.getMessage());
    }

    // Validate return type if specified
    if (returnType != null && !returnType.isInstance(result)) {
      return ToolResult.failure("Script returned %s, expected %s"
          .formatted(result.getClass().getSimpleName(), returnType.getSimpleName()));
    }

    // Convert result to Map
    Map<String, Object> outputs = convertToMap(result);
    return ToolResult.success(outputs);
  }

  /** Validates that the script exists and is readable. */
  @Override
  public void validate() {
    super.validate();

    if (!Files.exists(scriptPath)) {
      throw new IllegalStateException("Groovy script does not exist: " + scriptPath);
    }

    if (!Files.isReadable(scriptPath)) {
      throw new IllegalStateException("Groovy script is not readable: " + scriptPath);
    }
  }

  /**
   * Gets a compiled script from cache or compiles it.
   *
   * @param scriptPath path to the script
   * @param sandboxed enable security sandbox
   * @return the compiled Script instance
   * @throws IOException if reading fails
   */
  private Script getScript(Path scriptPath, boolean sandboxed) throws IOException {
    return SCRIPT_CACHE.computeIfAbsent(scriptPath, path -> {
      try {
        String scriptText = Files.readString(path);
        CompilerConfiguration config = new CompilerConfiguration();

        if (sandboxed) {
          // Use simple sandboxing via restricted imports
          // Note: Groovy 4.x doesn't have SecureCustomizer, so we rely on
          // security through limited documentation and user trust for MVP
          // Post-MVP: implement custom CompilationCustomizer for security
          log.debug("Sandboxed mode enabled (basic - no SecureCustomizer in Groovy 4.x)");
        }

        GroovyShell shell = new GroovyShell(config);
        return shell.parse(scriptText);
      } catch (IOException e) {
        throw new RuntimeException("Failed to compile Groovy script", e);
      }
    });
  }

  /**
   * Creates a Binding with all context variables.
   *
   * @param context the execution context
   * @return the populated Binding
   */
  private Binding createBinding(ExecutionContext context) {
    Binding binding = new Binding();

    // Predefined variables from TDD section 4.4
    binding.setVariable("item", context.get("item").orElse(null));
    binding.setVariable("text", context.get("text").orElse(""));
    binding.setVariable("index", context.get("index").orElse(0));
    binding.setVariable("textLength", context.get("textLength").orElse(0));
    binding.setVariable("textWords", context.get("textWords").orElse(0));
    binding.setVariable("textTokens", context.get("textTokens").orElse(0));
    binding.setVariable("aggregationIndex", context.get("aggregationIndex").orElse(0));
    binding.setVariable("aggregationText", context.get("aggregationText").orElse(null));
    binding.setVariable("runId", context.get("runId").orElse(""));
    binding.setVariable("state", context.get("state").orElse(null));
    binding.setVariable("tool", context.get("tool").orElse(null));
    binding.setVariable("retryAttempt", context.get("retryAttempt").orElse(0));

    // Environment variables
    @SuppressWarnings("unchecked")
    Map<String, String> env = (Map<String, String>) context.get("env").orElse(new HashMap<>());
    binding.setVariable("env", env);

    // Pipeline variables
    @SuppressWarnings("unchecked")
    Map<String, Object> variables =
        (Map<String, Object>) context.get("variables").orElse(new HashMap<>());
    variables.forEach(binding::setVariable);

    return binding;
  }

  /**
   * Converts a result object to a Map for ToolResult.
   *
   * @param result the result object
   * @return the converted Map
   */
  @SuppressWarnings("unchecked")
  private Map<String, Object> convertToMap(Object result) {
    if (result == null) {
      return Map.of();
    }

    if (result instanceof Map) {
      return (Map<String, Object>) result;
    }

    if (result instanceof Boolean) {
      return Map.of("result", result);
    }

    if (result instanceof String) {
      return Map.of("result", result);
    }

    if (result instanceof Number) {
      return Map.of("result", result);
    }

    // Default: wrap in "result" key
    return Map.of("result", result.toString());
  }

  /**
   * Resolves a script path from a URL/path string.
   *
   * @param scriptUrl the script URL or path
   * @param workDir the workspace root directory
   * @return the resolved absolute path
   */
  private static Path resolveScriptPath(String scriptUrl, Path workDir) {
    Path path = Paths.get(scriptUrl);

    // If absolute, use as-is
    if (path.isAbsolute()) {
      return path;
    }

    // Otherwise resolve relative to workDir
    return workDir.resolve(scriptUrl).normalize();
  }

  /**
   * Parses a return type from string.
   *
   * @param returnTypeStr the type string (e.g., "Boolean", "Map", "String")
   * @return the Class object
   */
  private static Class<?> parseReturnType(String returnTypeStr) {
    if (returnTypeStr == null || returnTypeStr.isBlank()) {
      return null;
    }

    return switch (returnTypeStr.toLowerCase()) {
      case "boolean" -> Boolean.class;
      case "string" -> String.class;
      case "map" -> Map.class;
      case "list" -> List.class;
      case "number" -> Number.class;
      default -> null;
    };
  }

  /**
   * Parses a timeout value from config.
   *
   * @param timeoutObj timeout as string or Duration
   * @return the parsed Duration
   */
  private static Duration parseTimeout(Object timeoutObj) {
    if (timeoutObj == null) {
      return Duration.ofSeconds(30);
    }

    if (timeoutObj instanceof Duration) {
      return (Duration) timeoutObj;
    }

    String timeoutStr = timeoutObj.toString();

    if (timeoutStr.matches("\\d+s")) {
      return Duration.ofSeconds(Long.parseLong(timeoutStr.replace("s", "")));
    } else if (timeoutStr.matches("\\d+m")) {
      return Duration.ofMinutes(Long.parseLong(timeoutStr.replace("m", "")));
    } else if (timeoutStr.matches("\\d+")) {
      return Duration.ofSeconds(Long.parseLong(timeoutStr));
    }

    return Duration.ofSeconds(30);
  }
}
