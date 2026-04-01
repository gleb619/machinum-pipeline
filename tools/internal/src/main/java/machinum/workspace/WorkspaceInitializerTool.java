package machinum.workspace;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import lombok.RequiredArgsConstructor;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.tool.Tool;
import machinum.tool.ToolInfo;
import machinum.workspace.WorkspaceLayout.ValidationResult;

@Slf4j
@RequiredArgsConstructor
public class WorkspaceInitializerTool implements Tool {

  private static final String SEED_TEMPLATE = "/templates/seed.template.yaml";
  private static final String TOOLS_TEMPLATE = "/templates/tools.template.yaml";
  private static final String PACKAGE_JSON_TEMPLATE = "/templates/package.template.json";

  @Override
  public ToolInfo info() {
    return ToolInfo.builder()
        .name("workspace-init")
        .description("Initializes workspace structure and configuration files")
        .build();
  }

  @Override
  @SneakyThrows
  public void bootstrap(BootstrapContext context) {
    boolean force = context.getForce();
    log.info("Bootstrapping workspace (force={})...", force);

    WorkspaceLayout layout = new WorkspaceLayout(context.getWorkspaceRoot());
    ValidationResult validationResult = layout.validate();
    if (!validationResult.isValid()) {
      throw new IllegalArgumentException("Workspace can't be created for provided path");
    }

    if (!isInitialized(layout)) {
      createDirectories(layout);

      generateSeedYaml(layout, force);
      generateToolsYaml(layout, force);

      Path toolsYamlPath = layout.getWorkDir().resolve("tools.yaml");
      if (Files.exists(toolsYamlPath)) {
        generatePackageJson(layout, force);
      }
    } else {
      log.info("Workspace already initialized, skipping creation");
    }

    // Create git hook for commit message validation
    createGitHook(layout);

    log.info("Bootstrap complete!");
  }

  public void createDirectories(WorkspaceLayout layout) throws IOException {
    log.info("Creating workspace structure in {}", layout.getWorkspaceRoot());

    Path workDir = layout.getWorkDir();
    Files.createDirectories(workDir);
    Files.createDirectories(layout.getScriptsDir());
    for (Path subdir : layout.getScriptsDirs()) {
      layout.createWithGitkeep(subdir);
    }
    Files.createDirectories(layout.getToolsCacheDir());
    Files.createDirectories(layout.getStateDir());

    Path chaptersDir = layout.getChaptersDir();
    Files.createDirectories(chaptersDir);
    layout.createWithGitkeep(chaptersDir.resolve("en"));

    Path manifestsDir = layout.getManifestsDir();
    Files.createDirectories(manifestsDir);

    Files.createDirectories(layout.getBuildDir());

    log.info("Workspace structure created successfully");
  }

  private void generateSeedYaml(WorkspaceLayout layout, boolean force) throws IOException {
    Path seedPath = layout.getWorkspaceRoot().resolve("seed.yaml");

    if (Files.exists(seedPath) && !force) {
      log.debug("seed.yaml already exists, skipping (use --force to overwrite)");
      return;
    }

    copyTemplate(SEED_TEMPLATE, seedPath);
    log.info("Generated: seed.yaml");
  }

  private void generateToolsYaml(WorkspaceLayout layout, boolean force) throws IOException {
    Path toolsPath = layout.getWorkDir().resolve("tools.yaml");

    if (Files.exists(toolsPath) && !force) {
      log.debug("tools.yaml already exists, skipping (use --force to overwrite)");
      return;
    }

    copyTemplate(TOOLS_TEMPLATE, toolsPath);
    log.info("Generated: .mt/tools.yaml");
  }

  public void generatePackageJson(WorkspaceLayout layout, boolean force) throws IOException {
    Path packagePath = layout.getWorkspaceRoot().resolve("package.json");

    if (Files.exists(packagePath) && !force) {
      log.debug("package.json already exists, skipping (use --force to overwrite)");
      return;
    }

    copyTemplate(PACKAGE_JSON_TEMPLATE, packagePath);
    log.info("Generated: package.json");
  }

  private void copyTemplate(String resourcePath, Path targetPath) throws IOException {
    try (InputStream input = getClass().getResourceAsStream(resourcePath)) {
      if (input == null) {
        throw new IOException("Template not found: " + resourcePath);
      }
      Files.copy(input, targetPath, StandardCopyOption.REPLACE_EXISTING);
    }
  }

  public boolean isInitialized(WorkspaceLayout layout) {
    return Files.exists(layout.getWorkDir())
        && Files.exists(layout.getChaptersDir())
        && Files.exists(layout.getManifestsDir());
  }

  private void createGitHook(WorkspaceLayout layout) throws IOException {
    layout.createGitHook(layout.getWorkspaceRoot());
  }

}
