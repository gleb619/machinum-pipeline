package machinum.cli.commands;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import machinum.cli.MachinumCli;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

class InstallCommandTest {

  @TempDir
  Path tempDir;

  private CommandLine cli;

  @BeforeEach
  void setUp() {
    MachinumCli machinumCli = new MachinumCli();
    cli = new CommandLine(machinumCli);
  }

  @Test
  void testFullWorkspaceInitialization() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    assertEquals(0, exitCode, "Install command should succeed");

    assertTrue(Files.exists(workspaceRoot.resolve(".mt")), ".mt directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts")), ".mt/scripts directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/conditions")),
        ".mt/scripts/conditions directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/transformers")),
        ".mt/scripts/transformers directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/validators")),
        ".mt/scripts/validators directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve("src/main")), "src/main directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve("src/main/manifests")),
        "src/main/manifests directory should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve("src/main/chapters")),
        "src/main/chapters directory should exist");
  }

  @Test
  void testTemplateFilesGenerated() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    assertEquals(0, exitCode);

    assertTrue(Files.exists(workspaceRoot.resolve("seed.yaml")), "seed.yaml should exist");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/tools.yaml")), ".mt/tools.yaml should exist");

    String seedContent = Files.readString(workspaceRoot.resolve("seed.yaml"));
    assertFalse(seedContent.isEmpty(), "seed.yaml should not be empty");
    assertTrue(seedContent.contains("version:"), "seed.yaml should contain version");

    String toolsContent = Files.readString(workspaceRoot.resolve(".mt/tools.yaml"));
    assertFalse(toolsContent.isEmpty(), ".mt/tools.yaml should not be empty");
    assertTrue(toolsContent.contains("body:"), "tools.yaml should contain body section");
  }

  @Test
  void testIdempotency() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode1 = cli.execute("install", "--workspace", workspaceRoot.toString());

    Path seedYaml = workspaceRoot.resolve("seed.yaml");
    String originalContent = Files.readString(seedYaml);
    String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
    Files.writeString(seedYaml, modifiedContent);

    int exitCode2 = cli.execute("install", "--workspace", workspaceRoot.toString());

    assertEquals(0, exitCode1);
    assertEquals(0, exitCode2);

    String contentAfterSecondInstall = Files.readString(seedYaml);
    assertTrue(
        contentAfterSecondInstall.contains("# modified"),
        "File should not be overwritten on second install");
  }

  @Test
  void testForceFlagOverwrites() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode1 = cli.execute("install", "--workspace", workspaceRoot.toString());

    Path seedYaml = workspaceRoot.resolve("seed.yaml");
    String originalContent = Files.readString(seedYaml);
    String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
    Files.writeString(seedYaml, modifiedContent);

    int exitCode2 = cli.execute("install", "--workspace", workspaceRoot.toString(), "--force");

    assertEquals(0, exitCode1);
    assertEquals(0, exitCode2);

    String contentAfterForce = Files.readString(seedYaml);
    assertFalse(
        contentAfterForce.contains("# modified"), "File should be overwritten with --force flag");
  }

  @Test
  void testPackageJsonGenerationWithNodeTools() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
    Files.createDirectories(toolsYaml.getParent());
    String toolsContent = """
        version: 1.0.0
        type: tools
        body:
          install:
            tools:
              - name: prettier-mock
                type: node
                version: "3.0.0"
              - name: eslint-mock
                type: node
                version: "8.0.0"
          tools:
            - name: prettier-mock
              type: node
              runtime: node
            - name: eslint-mock
              type: node
              runtime: node
        """;
    Files.writeString(toolsYaml, toolsContent);

    int exitCode = cli.execute("install", "-w", workspaceRoot.toString(), "bootstrap");

    assertEquals(0, exitCode);

    Path packageJson = workspaceRoot.resolve("package.json");
    assertTrue(
        Files.exists(packageJson), "package.json should be generated when node tools present");

    String packageContent = Files.readString(packageJson);
    assertTrue(
        packageContent.contains("prettier-mock"),
        "package.json should include prettier-mock dependency");
    assertTrue(
        packageContent.contains("eslint-mock"),
        "package.json should include eslint-mock dependency");
  }

  @Test
  void testPackageJsonSkippedWithoutNodeTools() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
    Files.createDirectories(toolsYaml.getParent());
    String toolsContent = """
        version: 1.0.0
        type: tools
        body:
          states:
            - name: BOOTSTRAP
              tools:
                - name: custom-validator
                  type: groovy
                  script: validators/custom.groovy
        """;
    Files.writeString(toolsYaml, toolsContent);

    int exitCode = cli.execute("install", "-w", workspaceRoot.toString(), "bootstrap");

    assertEquals(0, exitCode);

    Path packageJson = workspaceRoot.resolve("package.json");
    assertFalse(
        Files.exists(packageJson), "package.json should not be generated without node tools");
  }

  @Test
  void testGitkeepFilesCreated() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    assertEquals(0, exitCode);

    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/conditions/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/conditions/");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/transformers/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/transformers/");
    assertTrue(
        Files.exists(workspaceRoot.resolve(".mt/scripts/validators/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/validators/");
  }

  @Test
  void testDownloadSubcommand() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode = cli.execute("install", "-w", workspaceRoot.toString(), "download");

    assertEquals(0, exitCode);
  }

  @Test
  void testBootstrapSubcommand() throws Exception {
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    int exitCode = cli.execute("install", "-w", workspaceRoot.toString(), "bootstrap");

    assertEquals(0, exitCode);

    assertTrue(Files.exists(workspaceRoot.resolve(".mt")));
    assertTrue(Files.exists(workspaceRoot.resolve("seed.yaml")));
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/tools.yaml")));
  }
}
