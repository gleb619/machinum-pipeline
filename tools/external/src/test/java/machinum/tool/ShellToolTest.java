package machinum.tool;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import machinum.Tool.ToolResult;
import machinum.manifest.ToolManifestDepricated;
import machinum.pipeline.ExecutionContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class ShellToolTest {

  @TempDir
  Path tempDir;

  private ObjectMapper objectMapper;
  private Path scriptDir;

  @BeforeEach
  void setUp() {
    objectMapper = new ObjectMapper();
    // Resolve script directory relative to test execution directory (core module)
    scriptDir = Paths.get("src/test/resources/scripts-sh").toAbsolutePath().normalize();
  }

  @Test
  void testExecuteWithJsonInput() throws Exception {
    // Arrange
    ToolManifestDepricated def = createToolDefinition("echo_input.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("echo_input.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = new ExecutionContext(new ConcurrentHashMap<>());
    context.set("item", Map.of("id", "test-123", "content", "Hello"));

    // Act
    ToolResult result = tool.execute(context);

    // Assert
    if (!result.success()) {
      System.err.println("Error: " + result.errorMessage());
    }
    assertTrue(result.success());
    @SuppressWarnings("unchecked")
    Map<String, Object> item = (Map<String, Object>) result.outputs().get("item");
    assertEquals("test-123", item.get("id"));
    assertEquals("Hello", item.get("content"));
  }

  @Test
  void testExecuteWithTimeout() throws Exception {
    // Arrange
    ToolManifestDepricated def = createToolDefinition("slow_script.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("slow_script.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(1)) // 1 second timeout
        .args(List.of("10")) // Try to sleep for 10 seconds
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = new ExecutionContext(new ConcurrentHashMap<>());

    // Act
    ToolResult result = tool.execute(context);

    // Assert
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("timed out"));
  }

  @Test
  void testExecuteWithNonZeroExitCode() throws Exception {
    // Arrange
    ToolManifestDepricated def = createToolDefinition("exit_code.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("exit_code.sh"))
        .workDir(tempDir)
        .args(List.of("1")) // Exit with code 1
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = new ExecutionContext(new ConcurrentHashMap<>());

    // Act
    ToolResult result = tool.execute(context);

    // Assert
    if (!result.success()) {
      System.err.println("Error: " + result.errorMessage());
    }
    assertFalse(result.success());
    assertTrue(result.errorMessage().contains("exited with code"));
  }

  @Test
  void testExecuteWithEnvironmentVariables() throws Exception {
    // Arrange
    ToolManifestDepricated def = createToolDefinition("use_env.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("use_env.sh"))
        .workDir(tempDir)
        .environment(Map.of("TEST_VAR", "test-value"))
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = new ExecutionContext(new ConcurrentHashMap<>());

    // Act
    ToolResult result = tool.execute(context);

    // Assert
    assertTrue(result.success());
    assertEquals("test-value", result.outputs().get("env_var"));
  }

  @Test
  void testExecuteWithTransform() throws Exception {
    // Arrange
    ToolManifestDepricated def = createToolDefinition("transform.sh");
    ShellTool tool = ShellTool.builder()
        .definition(def)
        .scriptPath(scriptDir.resolve("transform.sh"))
        .workDir(tempDir)
        .timeout(Duration.ofSeconds(5))
        .objectMapper(objectMapper)
        .build();

    ExecutionContext context = new ExecutionContext(new ConcurrentHashMap<>());
    context.set("item", Map.of("id", "test-1", "value", "original"));

    // Act
    ToolResult result = tool.execute(context);

    // Assert
    if (!result.success()) {
      System.err.println("Error: " + result.errorMessage());
    }
    assertTrue(result.success());
    assertTrue((Boolean) result.outputs().get("processed"));
    @SuppressWarnings("unchecked")
    Map<String, Object> item = (Map<String, Object>) result.outputs().get("item");
    assertEquals("original", item.get("value"));
  }

  private ToolManifestDepricated createToolDefinition(String scriptName) {
    return ToolManifestDepricated.builder()
        .name(scriptName.replace(".sh", ""))
        .type("external")
        .toolConfig(Map.of("url", scriptName))
        .build();
  }
}
