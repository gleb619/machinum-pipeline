# Task: 5.4-workspace-init-integration-test

**Phase**: 5
**Priority**: P1
**Status**: `✅ Complete`
**Depends On**: Task 3.2 (WorkspaceInitializerTool), Task 3.3 (Package.json generation), Task 3.4 (InstallCommand CLI)
**TDD Reference**: `docs/tdd.md` section 7.1

---

## Description

Create comprehensive integration tests for workspace initialization to verify the full `machinum setup` flow including
directory structure creation, template file generation, idempotency, `--force` flag behavior, and `package.json`
generation when node tools are present.

---

## Acceptance Criteria

- [ ] Test executed in temporary directory to avoid side effects
- [ ] Test verifies all directories created (`.mt/`, `.mt/scripts/`, `src/main/`, etc.)
- [ ] Test verifies template files generated (`seed.yaml`, `tools.yaml`)
- [ ] Test verifies idempotency (second run skips existing files)
- [ ] Test verifies `--force` flag overwrites existing files
- [ ] Test verifies `package.json` generation when node tools present in `tools.yaml`
- [ ] Test verifies `package.json` skipped when no node tools
- [ ] Test verifies `.gitkeep` files created in empty directories
- [ ] Test verifies clear logging of created files/directories

---

## Implementation Notes

### Test Class Structure

```java
package machinum.workspace;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import machinum.cli.MachinumCli;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

class WorkspaceInitTest {

  @TempDir
  Path tempDir;

  private CommandLine cli;

  @BeforeEach
  void setUp() {
    cli = new CommandLine(new MachinumCli());
  }

  @Test
  void testFullWorkspaceInitialization() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Act
    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode, "Install command should succeed");

    // Verify directories created
    assertTrue(Files.exists(workspaceRoot.resolve(".mt")),
        ".mt directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts")),
        ".mt/scripts directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/conditions")),
        ".mt/scripts/conditions directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/transformers")),
        ".mt/scripts/transformers directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/validators")),
        ".mt/scripts/validators directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve("src/main")),
        "src/main directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve("src/main/manifests")),
        "src/main/manifests directory should exist");
    assertTrue(Files.exists(workspaceRoot.resolve("src/main/data")),
        "src/main/data directory should exist");
  }

  @Test
  void testTemplateFilesGenerated() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Act
    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify template files
    assertTrue(Files.exists(workspaceRoot.resolve("seed.yaml")),
        "seed.yaml should exist");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/tools.yaml")),
        ".mt/tools.yaml should exist");

    // Verify files are valid YAML
    String seedContent = Files.readString(workspaceRoot.resolve("seed.yaml"));
    assertNotNull(seedContent);
    assertTrue(seedContent.contains("version:"),
        "seed.yaml should contain version");

    String toolsContent = Files.readString(workspaceRoot.resolve(".mt/tools.yaml"));
    assertNotNull(toolsContent);
    assertTrue(toolsContent.contains("install:"),
        "tools.yaml should contain install section");
  }

  @Test
  void testIdempotency() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // First install
    int exitCode1 = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Modify a file to detect overwrite
    Path seedYaml = workspaceRoot.resolve("seed.yaml");
    String originalContent = Files.readString(seedYaml);
    String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
    Files.writeString(seedYaml, modifiedContent);

    // Act - Second install (should skip existing files)
    int exitCode2 = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode1);
    assertEquals(0, exitCode2);

    // Verify file was NOT overwritten (idempotent)
    String contentAfterSecondInstall = Files.readString(seedYaml);
    assertTrue(contentAfterSecondInstall.contains("# modified"),
        "File should not be overwritten on second install");
  }

  @Test
  void testForceFlagOverwrites() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // First install
    int exitCode1 = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Modify a file
    Path seedYaml = workspaceRoot.resolve("seed.yaml");
    String originalContent = Files.readString(seedYaml);
    String modifiedContent = originalContent.replace("version:", "# modified\nversion:");
    Files.writeString(seedYaml, modifiedContent);

    // Act - Install with --force (should overwrite)
    int exitCode2 = cli.execute("install", "--workspace", workspaceRoot.toString(), "--force");

    // Assert
    assertEquals(0, exitCode1);
    assertEquals(0, exitCode2);

    // Verify file WAS overwritten
    String contentAfterForce = Files.readString(seedYaml);
    assertFalse(contentAfterForce.contains("# modified"),
        "File should be overwritten with --force flag");
  }

  @Test
  void testPackageJsonGenerationWithNodeTools() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Create tools.yaml with node tools
    Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
    Files.createDirectories(toolsYaml.getParent());
    String toolsContent = """
        version: 1.0.0
        body:
            states:
              - name: DOWNLOAD
                tools:
                  - name: prettier-mock
                    version: "3.0.0"
                  - name: eslint-mock
                    version: "8.0.0"
              - name: BOOTSTRAP
                tools:
                  - tool: prettier-mock
                  # Shortcut for tool declaration
                  - eslint-mock
        """;
    Files.writeString(toolsYaml, toolsContent);

    // Act
    int exitCode = cli.execute("install", "bootstrap",
        "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify package.json generated
    Path packageJson = workspaceRoot.resolve("package.json");
    assertTrue(Files.exists(packageJson),
        "package.json should be generated when node tools present");

    // Verify package.json content
    String packageContent = Files.readString(packageJson);
    assertTrue(packageContent.contains("prettier"),
        "package.json should include prettier dependency");
    assertTrue(packageContent.contains("eslint"),
        "package.json should include eslint dependency");
  }

  @Test
  void testPackageJsonSkippedWithoutNodeTools() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Create tools.yaml without node tools
    Path toolsYaml = workspaceRoot.resolve(".mt/tools.yaml");
    Files.createDirectories(toolsYaml.getParent());
    String toolsContent = """
        version: 1.0.0
        body:
        states:
              - name: BOOTSTRAP
                tools:
                  - name: custom-validator
                    type: groovy
                    script: validators/custom.groovy
        """;
    Files.writeString(toolsYaml, toolsContent);

    // Act
    int exitCode = cli.execute("install", "bootstrap",
        "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify package.json NOT generated
    Path packageJson = workspaceRoot.resolve("package.json");
    assertFalse(Files.exists(packageJson),
        "package.json should not be generated without node tools");
  }

  @Test
  void testGitkeepFilesCreated() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Act
    int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify .gitkeep files in empty directories
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/conditions/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/conditions/");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/transformers/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/transformers/");
    assertTrue(Files.exists(workspaceRoot.resolve(".mt/scripts/validators/.gitkeep")),
        ".gitkeep should exist in .mt/scripts/validators/");
  }

  @Test
  void testDownloadSubcommand() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Act
    int exitCode = cli.execute("install", "download",
        "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify tool sources downloaded but workspace not bootstrapped
    // (specific behavior depends on implementation)
  }

  @Test
  void testBootstrapSubcommand() throws Exception {
    // Arrange
    Path workspaceRoot = tempDir.resolve("workspace");
    Files.createDirectory(workspaceRoot);

    // Act
    int exitCode = cli.execute("install", "bootstrap",
        "--workspace", workspaceRoot.toString());

    // Assert
    assertEquals(0, exitCode);

    // Verify workspace structure created
    assertTrue(Files.exists(workspaceRoot.resolve(".mt")));
    assertTrue(Files.exists(workspaceRoot.resolve("seed.yaml")));
  }
}
```

---

## Resources

**Key Documentation**:

- **Technical Design**: `docs/tdd.md` section 7.1 - Workspace Initialization
- **WorkspaceLayout**: `tools/internal/src/main/java/machinum/workspace/WorkspaceLayout.java`
- **WorkspaceInitializerTool**: `tools/internal/src/main/java/machinum/workspace/WorkspaceInitializerTool.java`
- **InstallCommand**: `cli/src/main/java/machinum/cli/commands/InstallCommand.java`

**Files to Create**:

- `tools/internal/src/test/java/machinum/workspace/WorkspaceInitializerToolTest.java`
- `cli/src/test/java/machinum/cli/commands/InstallCommandTest.java`

**Files to Read**:

- `tools/internal/src/main/java/machinum/workspace/WorkspaceLayout.java`
- `tools/internal/src/main/java/machinum/workspace/WorkspaceInitializerTool.java`
- `cli/src/main/java/machinum/cli/commands/InstallCommand.java`

---

## Spec

### Contracts

**CommandLine Execution**:

```java
CommandLine cli = new CommandLine(new MachinumCli());
int exitCode = cli.execute("install", "--workspace", workspaceRoot.toString());
```

**Directory Structure**:

```
workspace/
├── .mt/
│   ├── scripts/
│   │   ├── conditions/
│   │   ├── transformers/
│   │   └── validators/
│   └── tools.yaml
├── src/main/
│   ├── manifests/
│   └── data/
├── seed.yaml
└── package.json (if node tools present)
```

### Checklists

**Verification Commands**:

```bash
# Run workspace init integration tests
./gradlew :tools:internal:test --tests "*WorkspaceInitTest*"

# Run with verbose output
./gradlew :tools:internal:test --tests "*WorkspaceInitTest*" --info

# Verify test uses temporary directories
ls -la /tmp/ | grep workspace
```

### Plan

1. **Create test class** `WorkspaceInitTest.java`
2. **Implement full initialization test** (all directories created)
3. **Implement template file test** (seed.yaml, tools.yaml)
4. **Implement idempotency test** (second run skips files)
5. **Implement --force flag test** (overwrites existing)
6. **Implement package.json test** (with node tools)
7. **Implement package.json skip test** (without node tools)
8. **Implement .gitkeep test** (empty directories)
9. **Implement subcommand tests** (download, bootstrap)
10. **Run all tests** and fix any issues

### Quickstart

- `tools/internal/src/main/java/machinum/workspace/WorkspaceInitializerTool.java` - Tool implementation
- `cli/src/main/java/machinum/cli/commands/InstallCommand.java` - CLI command
- `cli/src/test/java/machinum/cli/HelpCommandTest.java` - Test style reference

---

## TDD Approach

### 1. Write Test First

Create test that expects workspace initialization to work

### 2. Run Test (Should Fail Initially)

Test will fail if workspace initialization is broken

### 3. Fix Implementation

Ensure `WorkspaceInitializerTool` and `InstallCommand` work correctly

### 4. Refine and Extend

- Add edge case tests (existing workspace, permissions)
- Add performance tests (large workspace)
- Add error handling tests (invalid paths, disk full)

---

## Result

Link to: `docs/results/5.4-workspace-init-integration-test.result.md`
