package machinum.cli.commands;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import machinum.cli.MachinumCli;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

class SetupCommandTest {

  @TempDir
  Path tempDir;

  private CommandLine cli;

  @BeforeEach
  void setUp() {
    MachinumCli machinumCli = new MachinumCli();
    cli = new CommandLine(machinumCli);
  }

  @Nested
  @DisplayName("Full Setup Command Tests")
  class FullSetupTests {

    @Test
    void testFullWorkspaceInitialization() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "--workspace", workspaceRoot.toString());

      assertEquals(0, exitCode, "Setup command should succeed");

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
      assertTrue(
          Files.exists(workspaceRoot.resolve("src/main")), "src/main directory should exist");
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

      int exitCode = cli.execute("setup", "--workspace", workspaceRoot.toString());

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
    void testGitHookCreated() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "--workspace", workspaceRoot.toString());

      assertEquals(0, exitCode);

      Path gitHook = workspaceRoot.resolve(".githooks/commit-msg.sh");
      assertTrue(Files.exists(gitHook), ".githooks/commit-msg.sh should exist");
      assertTrue(Files.isExecutable(gitHook), "Git hook should be executable");

      String hookContent = Files.readString(gitHook);
      assertTrue(
          hookContent.contains("feat|fix|docs|style|refactor"),
          "Hook should validate commit message format");
    }

    @Test
    void testIdempotency() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode1 = cli.execute("setup", "--workspace", workspaceRoot.toString());

      Path seedYaml = workspaceRoot.resolve("seed.yaml");
      String originalContent = Files.readString(seedYaml);
      String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
      Files.writeString(seedYaml, modifiedContent);

      int exitCode2 = cli.execute("setup", "--workspace", workspaceRoot.toString());

      assertEquals(0, exitCode1);
      assertEquals(0, exitCode2);

      String contentAfterSecondInstall = Files.readString(seedYaml);
      assertTrue(
          contentAfterSecondInstall.contains("# modified"),
          "File should not be overwritten on second setup");
    }

    @Test
    void testForceFlagOverwrites() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode1 = cli.execute("setup", "--workspace", workspaceRoot.toString());

      Path seedYaml = workspaceRoot.resolve("seed.yaml");
      String originalContent = Files.readString(seedYaml);
      String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
      Files.writeString(seedYaml, modifiedContent);

      int exitCode2 = cli.execute("setup", "--workspace", workspaceRoot.toString(), "--force");

      assertEquals(0, exitCode1);
      assertEquals(0, exitCode2);

      String contentAfterForce = Files.readString(seedYaml);
      assertFalse(
          contentAfterForce.contains("# modified"), "File should be overwritten with --force flag");
    }
  }

  @Nested
  @DisplayName("Download Subcommand Tests")
  class DownloadCommandTests {

    @Test
    void testDownloadSubcommand() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "download");

      assertEquals(0, exitCode, "Download command should succeed");
    }

    @Test
    void testDownloadWithToolsManifest() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
      Files.createDirectories(toolsYaml.getParent());
      String toolsContent = """
          version: 1.0.0
          type: tools
          body:
            registry: classpath://default
            tools:
              - name: workspace
          """;
      Files.writeString(toolsYaml, toolsContent);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "download");

      assertEquals(0, exitCode);
    }
  }

  @Nested
  @DisplayName("Bootstrap Subcommand Tests")
  class BootstrapCommandTests {

    @Test
    void testBootstrapSubcommand() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      assertEquals(0, exitCode);

      assertTrue(Files.exists(workspaceRoot.resolve(".mt")));
      assertTrue(Files.exists(workspaceRoot.resolve("seed.yaml")));
      assertTrue(Files.exists(workspaceRoot.resolve(".mt/tools.yaml")));
    }

    @Test
    void testBootstrapCreatesGitHook() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      assertEquals(0, exitCode);

      Path gitHook = workspaceRoot.resolve(".githooks/commit-msg.sh");
      assertTrue(Files.exists(gitHook), ".githooks/commit-msg.sh should exist");
      assertTrue(Files.isExecutable(gitHook), "Git hook should be executable");
    }

    @Test
    void testBootstrapIdempotency() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode1 = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      Path seedYaml = workspaceRoot.resolve("seed.yaml");
      String modifiedContent =
          Files.readString(seedYaml).replace("version:", "# modified\nversion:");
      Files.writeString(seedYaml, modifiedContent);

      int exitCode2 = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      assertEquals(0, exitCode1);
      assertEquals(0, exitCode2);

      String contentAfterSecondBootstrap = Files.readString(seedYaml);
      assertTrue(
          contentAfterSecondBootstrap.contains("# modified"),
          "File should not be overwritten on second bootstrap");
    }

    @Test
    void testBootstrapWithForceFlag() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode1 = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      Path seedYaml = workspaceRoot.resolve("seed.yaml");
      String modifiedContent =
          Files.readString(seedYaml).replace("version:", "# modified\nversion:");
      Files.writeString(seedYaml, modifiedContent);

      int exitCode2 = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap", "--force");

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
            bootstrap:
              - workspace
              - prettier
              - eslint
            tools:
              - name: workspace
          """;
      Files.writeString(toolsYaml, toolsContent);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      assertEquals(0, exitCode);

      Path packageJson = workspaceRoot.resolve("package.json");
      assertTrue(
          Files.exists(packageJson), "package.json should be generated when tools.yaml exists");

      String packageContent = Files.readString(packageJson);
      assertTrue(
          packageContent.contains("machinum-workspace"),
          "package.json should contain workspace name");
    }

    @Test
    void testPackageJsonGeneratedWhenToolsExist() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
      Files.createDirectories(toolsYaml.getParent());
      String toolsContent = """
          version: 1.0.0
          type: tools
          body:
            bootstrap:
              - workspace
            tools:
              - name: workspace
          """;
      Files.writeString(toolsYaml, toolsContent);

      int exitCode = cli.execute("setup", "-w", workspaceRoot.toString(), "bootstrap");

      assertEquals(0, exitCode);

      // package.json is generated because tools.yaml exists
      Path packageJson = workspaceRoot.resolve("package.json");
      assertTrue(
          Files.exists(packageJson), "package.json should be generated when tools.yaml exists");
    }
  }

  @Nested
  @DisplayName("Gitkeep Files Tests")
  class GitkeepTests {

    @Test
    void testGitkeepFilesCreated() throws Exception {
      Path workspaceRoot = tempDir.resolve("workspace");
      Files.createDirectory(workspaceRoot);

      int exitCode = cli.execute("setup", "--workspace", workspaceRoot.toString());

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
  }
}
