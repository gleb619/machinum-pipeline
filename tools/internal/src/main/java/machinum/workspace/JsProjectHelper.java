package machinum.workspace;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@RequiredArgsConstructor
public class JsProjectHelper {

  private static final String PACKAGE_JSON_TEMPLATE = "/templates/package.template.json";
  private static final String VALIDATE_MD_TEMPLATE = "/templates/validate-md-lines.template.js";

  public void generateValidateMdScript(WorkspaceLayout layout) throws IOException {
    Path githooksScriptsDir = layout.getWorkspaceRoot().resolve(".mt/scripts/validators");
    Files.createDirectories(githooksScriptsDir);

    Path scriptPath = githooksScriptsDir.resolve("validate-md-lines.js");
    copyTemplate(VALIDATE_MD_TEMPLATE, scriptPath);

    log.info("Generated: .mt/scripts/validators/validate-md-lines.js");
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

  public void generatePackageJsonIfToolsExist(WorkspaceLayout layout, boolean force)
      throws IOException {
    Path toolsYamlPath = layout.getWorkDir().resolve("tools.yaml");
    if (Files.exists(toolsYamlPath)) {
      generatePackageJson(layout, force);
    } else {
      log.debug("tools.yaml not found, skipping package.json generation");
    }
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
