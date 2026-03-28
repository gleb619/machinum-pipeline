package machinum.tool;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
import lombok.extern.slf4j.Slf4j;
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
@Slf4j
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
  protected ShellTool(
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

  // TODO: use or remove
  @Deprecated(forRemoval = true)
  public static ShellTool fromDefinition(ToolDefinition definition, Path workDir) {
    Map<String, Object> config = definition.toolConfig();

    String scriptUrl = (String) config.get("url");
    if (scriptUrl == null || scriptUrl.isBlank()) {
      throw new IllegalArgumentException("Shell tool must have a script url");
    }

    Path scriptPath = resolveScriptPath(scriptUrl, workDir);

    @SuppressWarnings("unchecked")
    List<String> args = (List<String>) config.get("args");

    @SuppressWarnings("unchecked")
    Map<String, String> env = (Map<String, String>) config.get("env");

    String interpreter = (String) config.get("interpreter");

    Duration timeout = parseTimeout(config.get("timeout"));

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

    log.info("""
        Executing script: {}
        Script exists: {}
        Script is executable: {}""", scriptPath, Files.exists(scriptPath), Files.isExecutable(scriptPath));

    List<String> command = new ArrayList<>();
    String actualInterpreter = interpreter != null ? interpreter : "bash";
    command.add(actualInterpreter);
    command.add(scriptPath.toString());
    if (args != null) {
      command.addAll(args);
    }

    log.info("Command: {}", command);

    ProcessBuilder pb = new ProcessBuilder(command);

    if (workDir != null && Files.exists(workDir)) {
      pb.directory(workDir.toFile());
    }

    if (environment != null) {
      pb.environment().putAll(environment);
    }

    pb.redirectErrorStream(true);

    Process process = pb.start();

    // Write input JSON to process stdin
    Map<String, Object> inputData = context.getAll();
    String inputJson = objectMapper.writeValueAsString(inputData);
    try (OutputStream stdin = process.getOutputStream()) {
      stdin.write(inputJson.getBytes(StandardCharsets.UTF_8));
    } catch (IOException ignore) {
      // Process may have exited before we finished writing (e.g., exit 1 immediately)
      // This is expected for fast-failing scripts; continue to read output
    }

    boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);

    if (!completed) {
      process.destroyForcibly();
      return ToolResult.failure("Shell script timed out after " + timeout);
    }

    StringBuilder outputBuilder = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (!outputBuilder.isEmpty()) {
          outputBuilder.append("\n");
        }
        outputBuilder.append(line);
      }
    }
    String output = outputBuilder.toString();

    int exitCode = process.exitValue();
    if (exitCode != 0) {
      return ToolResult.failure(
          "Shell script exited with code %d. Output: %s".formatted(exitCode, output));
    }

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

  private static Path resolveScriptPath(String scriptUrl, Path workDir) {
    Path path = Paths.get(scriptUrl);

    if (path.isAbsolute()) {
      return path;
    }

    return workDir.resolve(scriptUrl).normalize();
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
