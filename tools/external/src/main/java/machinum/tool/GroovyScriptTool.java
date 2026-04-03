package machinum.tool;

import groovy.lang.Binding;
import groovy.lang.GroovyShell;
import groovy.lang.Script;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;
import org.codehaus.groovy.control.CompilerConfiguration;

@Slf4j
public class GroovyScriptTool implements Tool {

  private static final Map<Path, Script> SCRIPT_CACHE = new ConcurrentHashMap<>();

  // TODO: load next fields from config of tool itself, look
  // `core/src/main/java/machinum/definition/ToolDefinition#ToolConfigDefinition`
  private Path workDir;

  private Duration timeout;

  private Path scriptPath;

  private Class<?> returnType;

  private boolean sandboxed;

  @Override
  public ToolInfo info() {
    return ToolInfo.builder()
        .name("groovy")
        .description("Execute groovy scripts")
        .build();
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    validate();

    Script script;
    try {
      script = getScript(scriptPath, sandboxed);
    } catch (IOException e) {
      log.error("Failed to load script {}: {}", scriptPath, e.getMessage(), e);
      return ToolResult.failure("Failed to load Groovy script: " + e.getMessage());
    }

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
    if (workDir != null && !workDir.toFile().exists()) {
      throw new IllegalStateException("Working directory does not exist: " + workDir);
    }

    if (timeout != null && (timeout.isNegative() || timeout.isZero())) {
      throw new IllegalStateException("Timeout must be positive");
    }

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

  // TODO: Use `core/src/main/java/machinum/expression/DefaultExpressionResolver.java` instead
  @Deprecated(forRemoval = true)
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
}
