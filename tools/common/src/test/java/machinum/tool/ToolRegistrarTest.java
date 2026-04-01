package machinum.tool;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ToolRegistrarTest {

  @Test
  void shouldGenerateYamlManifest(@TempDir Path tempDir) throws IOException {
    ToolRegistrar registrar = new ToolRegistrar(List.of());
    Path outputPath = tempDir.resolve("registry.yaml");

    RegistryManifest.ToolJarInfo jarInfo = RegistryManifest.ToolJarInfo.builder()
        .toolName("test-tool")
        .jarPath("/path/to/tool.jar")
        .className("com.example.TestTool")
        .dependencies(List.of("dep1", "dep2"))
        .signature("abc123")
        .build();

    RegistryManifest manifest = new RegistryManifest("registry", "1.0.0", List.of(jarInfo));

    registrar.writeManifest(manifest, outputPath);

    assertThat(Files.exists(outputPath)).isTrue();
    String yaml = Files.readString(outputPath);
    assertThat(yaml).contains("type: \"registry\"");
    assertThat(yaml).contains("version: \"1.0.0\"");
    assertThat(yaml).contains("test-tool");
    assertThat(yaml).contains("/path/to/tool.jar");
    assertThat(yaml).contains("abc123");

    System.out.println("Generated YAML:\n" + yaml);
  }

  @Test
  void shouldReadYamlManifest(@TempDir Path tempDir) throws IOException {
    ToolRegistrar registrar = new ToolRegistrar(List.of());

    //TODO: Move to resources
    String yaml = """
        type: registry
        version: 1.0.0
        jars:
          - toolName: test-tool
            jarPath: /path/to/tool.jar
            className: com.example.TestTool
            dependencies:
              - dep1
              - dep2
            signature: abc123
        """;

    Path inputPath = tempDir.resolve("registry.yaml");
    Files.writeString(inputPath, yaml);

    RegistryManifest manifest = registrar.readManifest(inputPath);

    assertThat(manifest.type()).isEqualTo("registry");
    assertThat(manifest.version()).isEqualTo("1.0.0");
    assertThat(manifest.jars()).hasSize(1);

    RegistryManifest.ToolJarInfo jarInfo = manifest.jars().get(0);
    assertThat(jarInfo.toolName()).isEqualTo("test-tool");
    assertThat(jarInfo.jarPath()).isEqualTo("/path/to/tool.jar");
    assertThat(jarInfo.className()).isEqualTo("com.example.TestTool");
    assertThat(jarInfo.dependencies()).containsExactly("dep1", "dep2");
    assertThat(jarInfo.signature()).isEqualTo("abc123");
  }

  @Test
  void shouldGenerateSignature() throws IOException {
    Path tempJar = Files.createTempFile("test", ".jar");
    Files.writeString(tempJar, "fake jar content");

    String signature = HmacVerifier.generateSignature(tempJar);

    assertThat(signature).isNotBlank();
    assertThat(signature).hasSize(64);

    assertThat(HmacVerifier.verifySignature(tempJar, signature)).isTrue();
    assertThat(HmacVerifier.verifySignature(tempJar, "wrong-signature")).isFalse();

    Files.deleteIfExists(tempJar);
  }
}
