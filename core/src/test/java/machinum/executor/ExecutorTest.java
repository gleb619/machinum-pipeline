package machinum.executor;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.definition.PipelineDefinition;
import machinum.executor.Executor.LifecycleContext;
import machinum.executor.Executor.LifecyclePhase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;
import tools.jackson.databind.ObjectMapper;

@Disabled("Temporarily disabled due development has not been completed yet")
class ExecutorTest {

  private Path tempWorkspace;
  private Executor executor;
  private ObjectMapper objectMapper;
  private Yaml yaml;

  @BeforeEach
  void setUp() throws IOException {
    tempWorkspace = Files.createTempDirectory("machinum-test-");
    objectMapper = new ObjectMapper();
    yaml = new Yaml();
    YamlManifestLoader loader = new YamlManifestLoader(objectMapper, yaml);
    RootManifestCompiler rootCompiler = RootManifestCompiler.INSTANCE;
    ToolsManifestCompiler toolsCompiler = ToolsManifestCompiler.INSTANCE;
    PipelineManifestCompiler pipelineCompiler = PipelineManifestCompiler.INSTANCE;

    // TODO: Fix compilation problem here
    // executor = new Executor(loader, rootCompiler, toolsCompiler, pipelineCompiler);
  }

  @AfterEach
  void tearDown() throws IOException {
    if (tempWorkspace != null && Files.exists(tempWorkspace)) {
      Files.walk(tempWorkspace).sorted((a, b) -> b.compareTo(a)).forEach(path -> {
        try {
          Files.deleteIfExists(path);
        } catch (IOException e) {
          // Ignore cleanup errors
        }
      });
    }
  }

  @Nested
  @DisplayName("FIND Phase - Manifest Discovery")
  class FindPhaseTests {

    @Test
    @DisplayName("findManifests loads root manifest (seed.yaml)")
    void testFindManifests_loadsRootManifest() throws IOException {
      // Arrange: Create seed.yaml
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
            variables:
              test_var: test_value
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      // Act
      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      // Assert
      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.rootManifest()).isPresent();
      assertThat(ctx.rootManifest().get().name()).isEqualTo("Test Root");
      assertThat(ctx.runId()).isNotNull();
    }

    @Test
    @DisplayName("findManifests loads tools manifest (.mt/tools.yaml)")
    void testFindManifests_loadsToolsManifest() throws IOException {
      // Arrange: Create .mt/tools.yaml
      Path mtDir = tempWorkspace.resolve(".mt");
      Files.createDirectory(mtDir);
      String toolsYaml = """
          version: 1.0.0
          type: tools
          name: "Test Tools"
          body:
            type: tools
            states: []
          """;
      Files.writeString(mtDir.resolve("tools.yaml"), toolsYaml);

      // Act
      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      // Assert
      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.toolsManifest()).isPresent();
      assertThat(ctx.toolsManifest().get().name()).isEqualTo("Test Tools");
    }

    @Test
    @DisplayName("findManifests loads pipeline manifest (src/main/manifests/*.yaml)")
    void testFindManifests_loadsPipelineManifest() throws IOException {
      // Arrange: Create seed.yaml and src/main/manifests/test-pipeline.yaml
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      Path manifestsDir = tempWorkspace.resolve("src/main/manifests");
      Files.createDirectories(manifestsDir);
      String pipelineYaml = """
          version: 1.0.0
          type: pipeline
          name: "test-pipeline"
          body:
            type: pipeline
            source:
              type: file
              file-location: "chapters"
              format: md
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      // Act
      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      // Assert - FIND phase should succeed, pipeline will be loaded in compile phase
      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.rootManifest()).isPresent();
    }

    @Test
    @DisplayName("findManifests returns empty when no root manifest exists")
    void testFindManifests_noRootManifest() throws IOException {
      // Act
      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      // Assert
      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.rootManifest()).isEmpty();
    }
  }

  @Nested
  @DisplayName("COMPILE Phase - Manifest Compilation")
  class CompilePhaseTests {

    @Test
    @DisplayName("compileManifests compiles root configuration")
    void testCompileManifests_compilesRootConfig() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          description: "Test Description"
          body:
            type: root
            variables:
              test_var: test_value
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);

      // Act
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Assert
      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
      assertThat(compileCtx.root().name()).isEqualTo("Test Root");
      assertThat(compileCtx.root().description()).isEqualTo("Test Description");
    }

    @Test
    @DisplayName("compileManifests compiles tools configuration")
    void testCompileManifests_compilesToolsConfig() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      Path mtDir = tempWorkspace.resolve(".mt");
      Files.createDirectory(mtDir);
      String toolsYaml = """
          version: 1.0.0
          type: tools
          name: "Test Tools"
          body:
            type: tools
            states: []
          """;
      Files.writeString(mtDir.resolve("tools.yaml"), toolsYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);

      // Act
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Assert
      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
      assertThat(compileCtx.tools()).isNotNull();
      assertThat(compileCtx.tools().name()).isEqualTo("Test Tools");
    }

    @Test
    @DisplayName("compileManifests compiles pipeline configuration")
    void testCompileManifests_compilesPipelineConfig() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      Path manifestsDir = tempWorkspace.resolve("src/main/manifests");
      Files.createDirectories(manifestsDir);
      String pipelineYaml = """
          version: 1.0.0
          type: pipeline
          name: "test-pipeline"
          body:
            type: pipeline
            source:
              type: file
              file-location: "chapters"
              format: md
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Act - Load pipeline separately
      //      var pipeline =
      //          executor.loadPipeline(tempWorkspace, "test-pipeline",
      // compileCtx.compilationContext());
      // TODO: It's forbidden to open private methods for tests
      var pipeline = PipelineDefinition.builder().build();

      // Assert
      assertThat(pipeline).isNotNull();
      assertThat(pipeline.name()).isEqualTo("test-pipeline");
      assertThat(pipeline.body().states()).hasSize(1);
      // State name is wrapped in Compiled - get the actual value
      String stateName = pipeline.body().states().get(0).name().get();
      assertThat(stateName).isEqualTo("PROCESS");
    }

    @Test
    @DisplayName("compileManifests throws exception when root manifest missing")
    void testCompileManifests_missingRootManifest_throwsException() throws IOException {
      // Arrange
      LifecycleContext findCtx = executor.findManifests(tempWorkspace);

      // Act & Assert
      assertThatThrownBy(() -> executor.compileManifests(findCtx))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("Root manifest")
          .hasMessageContaining("seed.yaml");
    }
  }

  @Nested
  @DisplayName("DOWNLOAD Phase - Tool Source Resolution")
  class DownloadPhaseTests {

    @Test
    @DisplayName("executeDownload completes when no tools defined")
    void testExecuteDownload_noToolsDefined() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Act & Assert - Should not throw
      executor.executeDownload(compileCtx);
    }
  }

  @Nested
  @DisplayName("BOOTSTRAP Phase - Workspace Initialization")
  class BootstrapPhaseTests {

    @Test
    @DisplayName("executeBootstrap completes successfully")
    void testExecuteBootstrap_completesSuccessfully() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Act & Assert - Should not throw
      executor.executeBootstrap(compileCtx, Boolean.FALSE);
    }
  }

  @Nested
  @DisplayName("Full Lifecycle - Install Command")
  class InstallLifecycleTests {

    @Test
    @DisplayName("executeInstall completes full lifecycle: FIND → COMPILE → DOWNLOAD → BOOTSTRAP")
    void testExecuteInstall_fullLifecycle() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      // Act
      LifecycleContext finalCtx = executor.executeInstall(tempWorkspace, false);

      // Assert
      assertThat(finalCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPLETE);
      assertThat(finalCtx.root()).isNotNull();
      assertThat(finalCtx.root().name()).isEqualTo("Test Root");
    }

    @Test
    @DisplayName("executeInstall throws exception when root manifest missing")
    void testExecuteInstall_missingRootManifest_throwsException() {
      // Act & Assert
      assertThatThrownBy(() -> executor.executeInstall(tempWorkspace, false))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("Root manifest")
          .hasMessageContaining("seed.yaml");
    }
  }

  @Nested
  @DisplayName("Pipeline Execution Lifecycle")
  class PipelineLifecycleTests {

    @Test
    @DisplayName("executePipeline loads and prepares pipeline for execution")
    void testExecutePipeline_loadsPipeline() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      Path manifestsDir = tempWorkspace.resolve("src/main/manifests");
      Files.createDirectories(manifestsDir);
      String pipelineYaml = """
          version: 1.0.0
          type: pipeline
          name: "test-pipeline"
          body:
            type: pipeline
            source:
              type: file
              file-location: "chapters"
              format: md
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      // Act
      LifecycleContext ctx = executor.executePipeline("test-pipeline", tempWorkspace, false, null);

      // Assert
      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(ctx.pipeline()).isNotNull();
      assertThat(ctx.pipeline().name()).isEqualTo("test-pipeline");
    }

    @Test
    @DisplayName("executePipeline throws exception when pipeline not found")
    void testExecutePipeline_pipelineNotFound_throwsException() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      // Act & Assert
      assertThatThrownBy(() -> executor.executePipeline("nonexistent", tempWorkspace, false, null))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("Pipeline manifest")
          .hasMessageContaining("nonexistent");
    }
  }

  @Nested
  @DisplayName("LifecycleContext Tests")
  class LifecycleContextTests {

    @Test
    @DisplayName("LifecycleContext builder preserves state across phases")
    void testLifecycleContext_builderPreservesState() throws IOException {
      // Arrange
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

      // Act
      LifecycleContext findCtx = executor.findManifests(tempWorkspace);
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // Assert
      assertThat(compileCtx.workspaceDir()).isEqualTo(findCtx.workspaceDir());
      assertThat(compileCtx.runId()).isEqualTo(findCtx.runId());
      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
    }

    @Test
    @DisplayName("LifecyclePhase enum has correct order")
    void testLifecyclePhase_enumOrder() {
      // Assert
      assertThat(LifecyclePhase.values())
          .containsExactly(
              LifecyclePhase.FIND,
              LifecyclePhase.COMPILE,
              LifecyclePhase.DOWNLOAD,
              LifecyclePhase.BOOTSTRAP,
              LifecyclePhase.COMPLETE);
    }
  }
}
