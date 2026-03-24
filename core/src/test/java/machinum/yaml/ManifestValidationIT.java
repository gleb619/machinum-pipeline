package machinum.yaml;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Integration tests for manifest validation. */
class ManifestValidationIT {

  @TempDir Path tempDir;

  private YamlManifestLoader loader;

  @BeforeEach
  void setUp() {
    loader = YamlManifestLoader.of();
  }

  @Test
  void testValidRootManifest() throws IOException {
    Path rootPath = tempDir.resolve("root.yaml");
    Files.writeString(
        rootPath,
        """
                name: test-workspace
                version: 1.0.0
                description: Test workspace
                """);

    RootManifest root = loader.loadRootManifest(rootPath);

    assertEquals("test-workspace", root.name());
    assertEquals("1.0.0", root.version());
  }

  @Test
  void testRootManifestMissingName() {
    assertThrows(
        YamlManifestLoader.ValidationException.class,
        () -> {
          Path rootPath = tempDir.resolve("root.yaml");
          Files.writeString(
              rootPath,
              """
                    version: 1.0.0
                    """);
          loader.loadRootManifest(rootPath);
        });
  }

  @Test
  void testValidToolsManifest() throws IOException {
    Path toolsPath = tempDir.resolve("tools.yaml");
    Files.writeString(
        toolsPath,
        """
                name: test-tools
                version: 1.0.0
                tools:
                  - name: tool1
                    type: internal
                    description: Test tool
                """);

    ToolsManifest tools = loader.loadToolsManifest(toolsPath);

    assertEquals("test-tools", tools.name());
    assertEquals(1, tools.tools().size());
    assertEquals("tool1", tools.tools().get(0).name());
  }

  @Test
  void testValidPipelineManifestWithSource() throws IOException {
    Path pipelinePath = tempDir.resolve("pipeline.yaml");
    Files.writeString(
        pipelinePath,
        """
                name: test-pipeline
                source: items.csv
                states:
                  - name: state1
                    tools:
                      - name: tool1
                        type: internal
                """);

    PipelineManifest pipeline = loader.loadPipelineManifest(pipelinePath);

    assertEquals("test-pipeline", pipeline.name());
    assertTrue(pipeline.sourceOrItems().hasSource());
    assertEquals(1, pipeline.pipelineStates().size());
  }

  @Test
  void testValidPipelineManifestWithItems() throws IOException {
    Path pipelinePath = tempDir.resolve("pipeline.yaml");
    Files.writeString(
        pipelinePath,
        """
                name: test-pipeline
                items:
                  - id: item1
                  - id: item2
                states:
                  - name: state1
                    tools:
                      - name: tool1
                        type: internal
                """);

    PipelineManifest pipeline = loader.loadPipelineManifest(pipelinePath);

    assertEquals("test-pipeline", pipeline.name());
    assertTrue(pipeline.sourceOrItems().hasItems());
    assertEquals(2, pipeline.sourceOrItems().items().size());
  }

  @Test
  void testPipelineManifestBothSourceAndItems() {
    assertThrows(
        YamlManifestLoader.ValidationException.class,
        () -> {
          Path pipelinePath = tempDir.resolve("pipeline.yaml");
          Files.writeString(
              pipelinePath,
              """
                    name: test-pipeline
                    source: items.csv
                    items:
                      - id: item1
                    states:
                      - name: state1
                        tools:
                          - name: tool1
                            type: internal
                    """);
          loader.loadPipelineManifest(pipelinePath);
        });
  }

  @Test
  void testPipelineManifestNeitherSourceNorItems() {
    assertThrows(
        YamlManifestLoader.ValidationException.class,
        () -> {
          Path pipelinePath = tempDir.resolve("pipeline.yaml");
          Files.writeString(
              pipelinePath,
              """
                    name: test-pipeline
                    states:
                      - name: state1
                        tools:
                          - name: tool1
                            type: internal
                    """);
          loader.loadPipelineManifest(pipelinePath);
        });
  }

  @Test
  void testPipelineManifestMissingStates() {
    assertThrows(
        YamlManifestLoader.ValidationException.class,
        () -> {
          Path pipelinePath = tempDir.resolve("pipeline.yaml");
          Files.writeString(
              pipelinePath,
              """
                    name: test-pipeline
                    source: items.csv
                    """);
          loader.loadPipelineManifest(pipelinePath);
        });
  }
}
