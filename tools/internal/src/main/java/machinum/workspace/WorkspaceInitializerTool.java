package machinum.workspace;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.tool.Tool;
import machinum.tool.ToolInfo;
import machinum.workspace.WorkspaceLayout.ValidationResult;

@Slf4j
public class WorkspaceInitializerTool implements Tool {

  private static final String SEED_TEMPLATE = "/templates/seed.template.yaml";
  private static final String TOOLS_TEMPLATE = "/templates/tools.template.yaml";

  private final FolderStructureHelper folderStructureHelper = new FolderStructureHelper();
  private final JsProjectHelper jsProjectHelper = new JsProjectHelper();

  @Override
  public ToolInfo info() {
    return ToolInfo.builder()
        .name("workspace")
        .description("Initializes workspace structure and configuration files")
        .build();
  }

  @Override
  @SneakyThrows
  public void bootstrap(BootstrapContext context) {
    boolean force = context.getForce();
    log.info("Bootstrapping workspace (force={})...", force);

    WorkspaceLayout layout = new WorkspaceLayout(context.getWorkspaceRoot());
    ValidationResult validationResult = folderStructureHelper.validate(layout);
    if (!validationResult.isValid()) {
      throw new IllegalArgumentException("Workspace can't be created for provided path");
    }

    boolean isInitialized = folderStructureHelper.isInitialized(layout);

    if (!isInitialized) {
      folderStructureHelper.createDirectories(layout);
      generateSeedYaml(layout, force);
      generateToolsYaml(layout, force);
    } else if (force) {
      // Force regeneration: overwrite config files even when workspace is initialized
      generateSeedYaml(layout, true);
      generateToolsYaml(layout, true);
    } else {
      log.info("Workspace already initialized, skipping creation");
    }

    // Generate package.json if tools.yaml exists
    jsProjectHelper.generatePackageJsonIfToolsExist(layout, force);

    // Create git hook for commit message validation
    folderStructureHelper.createGitHook(layout);

    // Generate validate-md-lines.js script
    jsProjectHelper.generateValidateMdScript(layout);

    log.info("Bootstrap complete!");
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

  private void copyTemplate(String resourcePath, Path targetPath) throws IOException {
    try (InputStream input = getClass().getResourceAsStream(resourcePath)) {
      if (input == null) {
        throw new IOException("Template not found: " + resourcePath);
      }
      Files.copy(input, targetPath, StandardCopyOption.REPLACE_EXISTING);
    }
  }
}
