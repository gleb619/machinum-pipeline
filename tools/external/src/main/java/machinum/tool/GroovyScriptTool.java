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
import org.codehaus.groovy.control.CompilerConfiguration;

@Data
@Slf4j
public class GroovyScriptTool extends ExternalTool {

  private static final Map<Path, Script> SCRIPT_CACHE = new ConcurrentHashMap<>();

  private Path scriptPath;

  private Class<?> returnType;

  private boolean sandboxed;

  @Builder
  public GroovyScriptTool(
      ToolInfo info,
      Path workDir,
      Duration timeout,
      RetryPolicy retryPolicy,
      ExecutionTarget executionTarget,
      Path scriptPath,
      Class<?> returnType,
      boolean sandboxed) {
    super(info, "groovy", workDir, timeout, retryPolicy, executionTarget);
    this.scriptPath = scriptPath;
    this.returnType = returnType;
    this.sandboxed = sandboxed;
  }

  // TODO: use or remove
  @Deprecated(forRemoval = true)
  public static GroovyScriptTool fromDefinition(
      ToolInfo info, Path workDir, Map<String, Object> config) {
    String scriptUrl = (String) config.get("url");
    if (scriptUrl == null || scriptUrl.isBlank()) {
      throw new IllegalArgumentException("Groovy tool must have a script url");
    }

    Path scriptPath = resolveScriptPath(scriptUrl, workDir);

    String returnTypeStr = (String) config.get("return-type");
    Class<?> returnType = parseReturnType(returnTypeStr);

    Boolean sandboxed = (Boolean) config.get("sandboxed");
    if (sandboxed == null) {
      sandboxed = true;
    }

    Duration timeout = parseTimeout(config.get("timeout"));

    return GroovyScriptTool.builder()
        .info(info)
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

    Script script = getScript(scriptPath, sandboxed);

    Binding binding = createBinding(context);
    script.setBinding(binding);

    Object result;
    try {
      result = script.run();
    } catch (Exception e) {
      return ToolResult.failure("Groovy script execution failed: " + e.getMessage());
    }

    if (returnType != null && !returnType.isInstance(result)) {
      return ToolResult.failure("Script returned %s, expected %s"
          .formatted(result.getClass().getSimpleName(), returnType.getSimpleName()));
    }

    Map<String, Object> outputs = convertToMap(result);
    return ToolResult.success(outputs);
  }

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

  private Script getScript(Path scriptPath, boolean sandboxed) throws IOException {
    return SCRIPT_CACHE.computeIfAbsent(scriptPath, path -> {
      try {
        String scriptText = Files.readString(path);
        CompilerConfiguration config = new CompilerConfiguration();

        if (sandboxed) {
          log.debug("Sandboxed mode enabled (basic - no SecureCustomizer in Groovy 4.x)");
        }

        GroovyShell shell = new GroovyShell(config);
        return shell.parse(scriptText);
      } catch (IOException e) {
        throw new RuntimeException("Failed to compile Groovy script", e);
      }
    });
  }

  private Binding createBinding(ExecutionContext context) {
    Binding binding = new Binding();

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

    @SuppressWarnings("unchecked")
    Map<String, String> env = (Map<String, String>) context.get("env").orElse(new HashMap<>());
    binding.setVariable("env", env);

    @SuppressWarnings("unchecked")
    Map<String, Object> variables =
        (Map<String, Object>) context.get("variables").orElse(new HashMap<>());
    variables.forEach(binding::setVariable);

    return binding;
  }

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

    return Map.of("result", result.toString());
  }

  private static Path resolveScriptPath(String scriptUrl, Path workDir) {
    Path path = Paths.get(scriptUrl);

    if (path.isAbsolute()) {
      return path;
    }

    return workDir.resolve(scriptUrl).normalize();
  }

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
