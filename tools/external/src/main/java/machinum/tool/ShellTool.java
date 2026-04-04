package machinum.tool;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Slf4j
public class ShellTool implements Tool {

  // TODO: load next fields from config of tool itself, look
  // `core/src/main/java/machinum/definition/ToolDefinition#ToolConfigDefinition`
  private Path workDir;

  private Duration timeout;

  private Path scriptPath;

  private List<String> args;

  private Map<String, String> environment;

  private String interpreter;

  private ObjectMapper objectMapper;

  @Override
  public ToolInfo info() {
    return ToolInfo.builder().name("shell").description("Execute shell scripts").build();
  }

  @Data
  @Builder
  @NoArgsConstructor
  @AllArgsConstructor
  public static class RetryPolicy {

    private int maxAttempts;

    private Duration initialDelay;

    private double multiplier;

    private double jitter;

    public static RetryPolicy defaultPolicy() {
      return new RetryPolicy(0, Duration.ofSeconds(1), 1.0, 0.0);
    }
  }

  @SneakyThrows
  @Override
  public ToolResult execute(ExecutionContext context) {
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
      return ToolResult.failure(context, "Shell script timed out after " + timeout);
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
          context, "Shell script exited with code %d. Output: %s".formatted(exitCode, output));
    }

    try {
      JsonNode resultNode = objectMapper.readTree(output.trim());
      @SuppressWarnings("unchecked")
      Map<String, Object> outputs =
          (Map<String, Object>) objectMapper.convertValue(resultNode, Map.class);
      return ToolResult.success(context, outputs);
    } catch (Exception e) {
      return ToolResult.failure(
          context, "Invalid JSON output from shell script: " + e.getMessage());
    }
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
      throw new IllegalStateException("Shell script does not exist: " + scriptPath);
    }

    if (!Files.isReadable(scriptPath)) {
      throw new IllegalStateException("Shell script is not readable: " + scriptPath);
    }
  }
}
