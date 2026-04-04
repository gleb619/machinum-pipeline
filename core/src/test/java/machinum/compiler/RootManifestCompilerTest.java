package machinum.compiler;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import javax.script.ScriptEngineManager;
import machinum.definition.RootDefinition;
import machinum.expression.DefaultExpressionResolver;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineBody.ErrorStrategy;
import machinum.manifest.PipelineBody.ErrorStrategyManifest;
import machinum.manifest.PipelineBody.FallbackManifest;
import machinum.manifest.PipelineConfigManifest;
import machinum.manifest.PipelineConfigManifest.ManifestSnapshotConfig;
import machinum.manifest.RootBody;
import machinum.manifest.RootBody.RootCleanupManifest;
import machinum.manifest.RootBody.RootExecutionManifest;
import machinum.manifest.RootManifest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RootManifestCompilerTest {

  private ExpressionResolver resolver;
  private ScriptRegistry scriptRegistry;

  @TempDir
  Path tempDir;

  @BeforeEach
  void setUp() {
    resolver = new DefaultExpressionResolver(new ScriptEngineManager());
    scriptRegistry = new ScriptRegistry(tempDir.resolve(".mt/scripts")).init();
  }

  private CompilationContext ctxWith(Map<String, String> env) {
    var builder = CompilationContext.builder()
        .resolver(resolver)
        .scriptRegistry(scriptRegistry)
        .workspaceDir(tempDir)
        .variable("rootDir", tempDir.toString());
    for (var entry : env.entrySet()) {
      builder = builder.env(entry.getKey(), entry.getValue());
    }
    return builder.build();
  }

  private CompilationContext ctxWithEnvFiles(String... envFileNames) throws IOException {
    EnvironmentLoader loader = EnvironmentLoader.builder().build();
    if (envFileNames.length == 0) {
      loader.loadFromDirectory(tempDir);
    } else {
      Path[] paths = new Path[envFileNames.length];
      for (int i = 0; i < envFileNames.length; i++) {
        paths[i] = tempDir.resolve(envFileNames[i]);
      }
      loader.loadFromPaths(paths);
    }
    return ctxWith(loader.getAll());
  }

  @Nested
  @DisplayName("CompiledSecret")
  class CompiledSecretTests {

    @Test
    @DisplayName("stores env values privately")
    void testStoresPrivateValues() {
      ExpressionContext exprCtx = ExpressionContext.builder().build();
      CompiledSecret secret =
          CompiledSecret.of(Map.of("DB_PASS", "s3cret", "API_KEY", "abc123"), exprCtx, resolver);

      assertThat(secret.get("DB_PASS")).isEqualTo(Optional.of("s3cret"));
      assertThat(secret.get("API_KEY")).isEqualTo(Optional.of("abc123"));
      assertThat(secret.get("MISSING")).isEmpty();
      assertThat(secret.isEmpty()).isFalse();
    }

    @Test
    @DisplayName("handles empty map")
    void testEmptySecret() {
      ExpressionContext exprCtx = ExpressionContext.builder().build();
      CompiledSecret secret = CompiledSecret.of(Map.of(), exprCtx, resolver);

      assertThat(secret.isEmpty()).isTrue();
      assertThat(secret.get("ANY")).isEmpty();
    }

    @Test
    @DisplayName("compiles lazily via get()")
    void testLazyEvaluation() {
      ExpressionContext exprCtx = ExpressionContext.builder().build();
      CompiledSecret secret = CompiledSecret.of(Map.of("STATIC", "value1"), exprCtx, resolver);

      assertThat(secret.get("STATIC")).isEqualTo(Optional.of("value1"));
    }
  }

  @Nested
  @DisplayName("EnvironmentLoader")
  class EnvironmentLoaderTests {

    @Test
    @DisplayName("loadFromDirectory loads .env and .ENV")
    void testLoadFromDirectory() throws IOException {
      Files.writeString(tempDir.resolve(".env"), "KEY1=val1\n");
      Files.writeString(tempDir.resolve(".ENV"), "KEY2=val2\n");

      EnvironmentLoader loader = EnvironmentLoader.builder().build();
      loader.loadFromDirectory(tempDir);

      assertThat(loader.get("KEY1")).isEqualTo("val1");
      assertThat(loader.get("KEY2")).isEqualTo("val2");
    }

    @Test
    @DisplayName("loadFromPaths loads specific files")
    void testLoadFromPaths() throws IOException {
      Files.writeString(tempDir.resolve("custom.env"), "CUSTOM_KEY=custom_val\n");

      EnvironmentLoader loader = EnvironmentLoader.builder().build();
      loader.loadFromPaths(tempDir.resolve("custom.env"));

      assertThat(loader.get("CUSTOM_KEY")).isEqualTo("custom_val");
    }

    @Test
    @DisplayName("loadFromPaths with empty list loads nothing")
    void testLoadFromPathsEmpty() {
      EnvironmentLoader loader = EnvironmentLoader.builder().build();
      loader.loadFromPaths();

      assertThat(loader.getAll()).isEmpty();
    }
  }

  @Nested
  @DisplayName("RootBodyDefinition compilation")
  class RootBodyCompilationTests {

    @Test
    @DisplayName("compiles variables to CompiledMap")
    void testCompilesVariables() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder().variable("book_id", "my_book").build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body()).isNotNull();
      assertThat(def.body().variables()).isNotNull();
    }

    @Test
    @DisplayName("compiles execution section")
    void testCompilesExecution() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .execution(RootExecutionManifest.builder()
                  .parallel(true)
                  .maxConcurrency(4)
                  .manifestSnapshot(ManifestSnapshotConfig.builder()
                      .enabled(true)
                      .mode("copy")
                      .build())
                  .build())
              .build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().execution()).isNotNull();
      assertThat(def.body().execution().parallel().get()).isTrue();
      assertThat(def.body().execution().maxConcurrency().get()).isEqualTo(4);
      assertThat(def.body().execution().manifestSnapshotEnabled().get()).isTrue();
      assertThat(def.body().execution().manifestSnapshotMode().get()).isEqualTo("copy");
    }

    @Test
    @DisplayName("compiles config section")
    void testCompilesConfig() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .config(PipelineConfigManifest.builder()
                  .batchSize(10)
                  .windowBatchSize(5)
                  .cooldown("5s")
                  .allowOverrideMode(false)
                  .build())
              .build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().config()).isNotNull();
      assertThat(def.body().config().batchSize().get()).isEqualTo(10);
      assertThat(def.body().config().windowBatchSize().get()).isEqualTo(5);
      assertThat(def.body().config().cooldown().get()).isEqualTo("5s");
      assertThat(def.body().config().allowOverrideMode().get()).isFalse();
    }

    @Test
    @DisplayName("compiles cleanup section")
    void testCompilesCleanup() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .cleanup(RootCleanupManifest.builder()
                  .success("5d")
                  .failed("7d")
                  .successRuns("5")
                  .failedRuns("10")
                  .build())
              .build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().cleanup()).isNotNull();
      assertThat(def.body().cleanup().success().get()).isEqualTo("5d");
      assertThat(def.body().cleanup().failed().get()).isEqualTo("7d");
    }

    @Test
    @DisplayName("compiles fallback section")
    void testCompilesFallback() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .fallback(FallbackManifest.builder()
                  .defaultStrategy("retry")
                  .strategy(ErrorStrategyManifest.builder()
                      .exception("TimeoutException")
                      .strategy(ErrorStrategy.retry)
                      .build())
                  .build())
              .build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().fallback()).isNotNull();
      assertThat(def.body().fallback().defaultStrategy().get()).isEqualTo("retry");
    }

    @Test
    @DisplayName("env is compiled as CompiledSecret")
    void testEnvCompiledAsSecret() {
      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .env("API_KEY", "test-key")
              .env("DB_PASS", "secret")
              .build())
          .build();

      CompilationContext ctx = ctxWith(Map.of());
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().secrets()).isNotNull();
      assertThat(def.body().secrets()).isInstanceOf(CompiledSecret.class);
      assertThat(def.body().secrets().get("API_KEY")).isEqualTo(Optional.of("test-key"));
      assertThat(def.body().secrets().get("DB_PASS")).isEqualTo(Optional.of("secret"));
    }
  }

  @Nested
  @DisplayName("envFiles loading")
  class EnvFilesTests {

    @Test
    @DisplayName("loads env from specified envFiles")
    void testLoadsFromEnvFiles() throws IOException {
      Files.writeString(tempDir.resolve("custom.env"), "MY_SECRET=from_file\n");

      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder()
              .envFile("custom.env")
              .env("INLINE", "inline_val")
              .build())
          .build();

      CompilationContext ctx = ctxWithEnvFiles("custom.env");
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().secrets()).isNotNull();
      assertThat(def.body().secrets().get("MY_SECRET")).isEqualTo(Optional.of("from_file"));
      assertThat(def.body().secrets().get("INLINE")).isEqualTo(Optional.of("inline_val"));
    }

    @Test
    @DisplayName("empty envFiles falls back to .env and .ENV at workspace root")
    void testEmptyEnvFilesFallback() throws IOException {
      Files.writeString(tempDir.resolve(".env"), "FALLBACK_KEY=fallback_val\n");
      Files.writeString(tempDir.resolve(".ENV"), "ENV_KEY=env_val\n");

      RootManifest manifest = RootManifest.builder()
          .version("1.0.0")
          .type("root")
          .name("test")
          .body(RootBody.builder().env("INLINE", "inline_val").build())
          .build();

      CompilationContext ctx = ctxWithEnvFiles();
      RootDefinition def = RootManifestCompiler.INSTANCE.compile(manifest, ctx);

      assertThat(def.body().secrets()).isNotNull();
      assertThat(def.body().secrets().get("FALLBACK_KEY")).isEqualTo(Optional.of("fallback_val"));
      assertThat(def.body().secrets().get("ENV_KEY")).isEqualTo(Optional.of("env_val"));
      assertThat(def.body().secrets().get("INLINE")).isEqualTo(Optional.of("inline_val"));
    }
  }
}
