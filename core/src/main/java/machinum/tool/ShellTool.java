package machinum.tool;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import lombok.Builder;
import lombok.Data;
import machinum.pipeline.ExecutionContext;
import machinum.yaml.ToolDefinition;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * External tool that executes shell scripts with JSON I/O.
 *
 * <p>Scripts receive JSON input via stdin and must produce JSON output to stdout. Exit code 0
 * indicates success; non-zero indicates failure.
 */
@Data
public class ShellTool extends ExternalTool {

  /** Path to the shell script. */
  private Path scriptPath;

  /** Command-line arguments for the script. */
  private List<String> args;

  /** Environment variables for script execution. */
  private Map<String, String> environment;

  /** Shell interpreter (default: bash). */
  private String interpreter;

  private ObjectMapper objectMapper;

  @Builder
  public ShellTool(
      ToolDefinition definition,
      Path workDir,
      Duration timeout,
      RetryPolicy retryPolicy,
      ExecutionTarget executionTarget,
      Path scriptPath,
      List<String> args,
      Map<String, String> environment,
      String interpreter,
      ObjectMapper objectMapper) {
    super(definition, "shell", workDir, timeout, retryPolicy, executionTarget);
    this.scriptPath = scriptPath;
    this.args = args;
    this.environment = environment;
    this.interpreter = interpreter;
    this.objectMapper = objectMapper;
  }

  /**
   * Creates a ShellTool from a ToolDefinition.
   *
   * @param definition tool definition with config
   * @param workDir workspace root directory
   * @return configured ShellTool instance
   * @throws IllegalArgumentException if script path is missing or invalid
   */
  // TODO: use or remove
  @Deprecated(forRemoval = true)
  public static ShellTool fromDefinition(ToolDefinition definition, Path workDir) {
    Map<String, Object> config = definition.toolConfig();

    // Resolve script path
    String scriptUrl = (String) config.get("url");
    if (scriptUrl == null || scriptUrl.isBlank()) {
      throw new IllegalArgumentException("Shell tool must have a script url");
    }

    Path scriptPath = resolveScriptPath(scriptUrl, workDir);

    // Get optional arguments
    @SuppressWarnings("unchecked")
    List<String> args = (List<String>) config.get("args");

    // Get optional environment
    @SuppressWarnings("unchecked")
    Map<String, String> env = (Map<String, String>) config.get("env");

    // Get optional interpreter
    String interpreter = (String) config.get("interpreter");

    // Get optional timeout
    Duration timeout = parseTimeout(config.get("timeout"));

    // Get optional work-dir override
    String workDirStr = (String) config.get("work-dir");
    Path actualWorkDir = workDirStr != null ? Paths.get(workDirStr) : workDir;

    return ShellTool.builder()
        .definition(definition)
        .scriptPath(scriptPath)
        .args(args)
        .environment(env)
        .interpreter(interpreter)
        .workDir(actualWorkDir)
        .timeout(timeout)
        .build();
  }

  @Override
  public ToolResult execute(ExecutionContext context) throws Exception {
    validate();

    // Build command list
    List<String> command = new ArrayList<>();
    command.add(interpreter);
    command.add(scriptPath.toString());
    command.addAll(args);

    ProcessBuilder pb = new ProcessBuilder(command);

    // Set working directory
    if (workDir != null && Files.exists(workDir)) {
      pb.directory(workDir.toFile());
    }

    // Set environment variables
    pb.environment().putAll(environment);

    // Redirect stderr to stdout for unified output capture
    pb.redirectErrorStream(true);

    // Start process
    Process process = pb.start();

    // Wait for completion with timeout
    boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);

    if (!completed) {
      process.destroyForcibly();
      return ToolResult.failure("Shell script timed out after " + timeout);
    }

    // Read output
    String output;
    try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
      output = reader.lines().reduce("", (a, b) -> a + "\n" + b);
    }

    // Check exit code
    int exitCode = process.exitValue();
    if (exitCode != 0) {
      return ToolResult.failure(
          "Shell script exited with code %d. Output: %s".formatted(exitCode, output));
    }

    // Parse JSON output
    try {
      JsonNode resultNode = objectMapper.readTree(output.trim());
      @SuppressWarnings("unchecked")
      Map<String, Object> outputs =
          (Map<String, Object>) objectMapper.convertValue(resultNode, Map.class);
      return ToolResult.success(outputs);
    } catch (Exception e) {
      return ToolResult.failure("Invalid JSON output from shell script: " + e.getMessage());
    }
  }

  /** Validates that the script exists and is executable. */
  @Override
  public void validate() {
    super.validate();

    if (!Files.exists(scriptPath)) {
      throw new IllegalStateException("Shell script does not exist: " + scriptPath);
    }

    if (!Files.isReadable(scriptPath)) {
      throw new IllegalStateException("Shell script is not readable: " + scriptPath);
    }
  }

  /**
   * Resolves a script path from a URL/path string.
   *
   * @param scriptUrl the script URL or path
   * @param workDir the workspace root directory
   * @return the resolved absolute path
   */
  private static Path resolveScriptPath(String scriptUrl, Path workDir) {
    // Handle expression resolution if needed (caller should resolve {{...}} before this)
    Path path = Paths.get(scriptUrl);

    // If absolute, use as-is
    if (path.isAbsolute()) {
      return path;
    }

    // Otherwise resolve relative to workDir
    return workDir.resolve(scriptUrl).normalize();
  }

  /**
   * Parses a timeout value from config.
   *
   * @param timeoutObj timeout as string (e.g., "30s", "1m") or Duration
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

    // Parse duration string (e.g., "30s", "1m", "5m30s")
    if (timeoutStr.matches("\\d+s")) {
      return Duration.ofSeconds(Long.parseLong(timeoutStr.replace("s", "")));
    } else if (timeoutStr.matches("\\d+m")) {
      return Duration.ofMinutes(Long.parseLong(timeoutStr.replace("m", "")));
    } else if (timeoutStr.matches("\\d+")) {
      return Duration.ofSeconds(Long.parseLong(timeoutStr));
    }

    // Default
    return Duration.ofSeconds(30);
  }
}
