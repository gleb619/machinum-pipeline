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
import machinum.executor.LifecycleContext.LifecyclePhase;
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

      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.rootManifest()).isPresent();
      assertThat(ctx.rootManifest().get().name()).isEqualTo("Test Root");
      assertThat(ctx.runId()).isNotNull();
    }

    @Test
    @DisplayName("findManifests loads tools manifest (.mt/tools.yaml)")
    void testFindManifests_loadsToolsManifest() throws IOException {
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

      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.toolsManifest()).isPresent();
      assertThat(ctx.toolsManifest().get().name()).isEqualTo("Test Tools");
    }

    @Test
    @DisplayName("findManifests loads pipeline manifest (src/main/manifests/*.yaml)")
    void testFindManifests_loadsPipelineManifest() throws IOException {
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
            source:
              uri: "file://./chapters/test.jsonl"
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      LifecycleContext ctx = executor.findManifests(tempWorkspace);

      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.FIND);
      assertThat(ctx.rootManifest()).isPresent();
    }

    @Test
    @DisplayName("findManifests returns empty when no root manifest exists")
    void testFindManifests_noRootManifest() throws IOException {
      LifecycleContext ctx = executor.findManifests(tempWorkspace);

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

      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
      assertThat(compileCtx.root().name()).isEqualTo("Test Root");
      assertThat(compileCtx.root().description()).isEqualTo("Test Description");
    }

    @Test
    @DisplayName("compileManifests compiles tools configuration")
    void testCompileManifests_compilesToolsConfig() throws IOException {
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

      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
      assertThat(compileCtx.tools()).isNotNull();
      assertThat(compileCtx.tools().name()).isEqualTo("Test Tools");
    }

    @Test
    @DisplayName("compileManifests compiles pipeline configuration")
    void testCompileManifests_compilesPipelineConfig() throws IOException {
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
              uri: "file://./chapters/test.jsonl"
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      LifecycleContext findCtx = executor.findManifests(tempWorkspace);
      LifecycleContext compileCtx = executor.compileManifests(findCtx);

      // TODO: It's forbidden to open private methods for tests
      var pipeline = PipelineDefinition.builder().build();

      assertThat(pipeline).isNotNull();
      assertThat(pipeline.name()).isEqualTo("test-pipeline");
      assertThat(pipeline.body().states()).hasSize(1);
      String stateName = pipeline.body().states().get(0).name().get();
      assertThat(stateName).isEqualTo("PROCESS");
    }

    @Test
    @DisplayName("compileManifests throws exception when root manifest missing")
    void testCompileManifests_missingRootManifest_throwsException() throws IOException {
      LifecycleContext findCtx = executor.findManifests(tempWorkspace);

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

      executor.executeDownload(compileCtx);
    }
  }

  @Nested
  @DisplayName("BOOTSTRAP Phase - Workspace Initialization")
  class BootstrapPhaseTests {

    @Test
    @DisplayName("executeBootstrap completes successfully")
    void testExecuteBootstrap_completesSuccessfully() throws IOException {
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

      executor.executeBootstrap(compileCtx, Boolean.FALSE);
    }
  }

  @Nested
  @DisplayName("Pipeline Execution Lifecycle")
  class PipelineLifecycleTests {

    @Test
    @DisplayName("executePipeline loads and prepares pipeline for execution")
    void testExecutePipeline_loadsPipeline() throws IOException {
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
              uri: "file://./chapters/test.jsonl"
            states:
              - name: PROCESS
                tools:
                  - tool: mock-tool
          """;
      Files.writeString(manifestsDir.resolve("test-pipeline.yaml"), pipelineYaml);

      LifecycleContext ctx = executor.executePipeline("test-pipeline", tempWorkspace, false, null);

      assertThat(ctx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(ctx.pipeline()).isNotNull();
      assertThat(ctx.pipeline().name()).isEqualTo("test-pipeline");
    }

    @Test
    @DisplayName("executePipeline throws exception when pipeline not found")
    void testExecutePipeline_pipelineNotFound_throwsException() throws IOException {
      String rootYaml = """
          version: 1.0.0
          type: root
          name: "Test Root"
          body:
            type: root
          """;
      Files.writeString(tempWorkspace.resolve("seed.yaml"), rootYaml);

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

      assertThat(compileCtx.workspaceDir()).isEqualTo(findCtx.workspaceDir());
      assertThat(compileCtx.runId()).isEqualTo(findCtx.runId());
      assertThat(compileCtx.currentPhase()).isEqualTo(LifecyclePhase.COMPILE);
      assertThat(compileCtx.root()).isNotNull();
    }

    @Test
    @DisplayName("LifecyclePhase enum has correct order")
    void testLifecyclePhase_enumOrder() {
      assertThat(LifecyclePhase.values())
          .containsExactly(
              LifecyclePhase.FIND,
              LifecyclePhase.COMPILE,
              LifecyclePhase.DOWNLOAD,
              LifecyclePhase.BOOTSTRAP,
              LifecyclePhase.AFTER_BOOTSTRAP,
              LifecyclePhase.CHECK,
              LifecyclePhase.RUN,
              LifecyclePhase.PAUSE,
              LifecyclePhase.RESUME,
              LifecyclePhase.COMPLETE);
    }
  }
}
