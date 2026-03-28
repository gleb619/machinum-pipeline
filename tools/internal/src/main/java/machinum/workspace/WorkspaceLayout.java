package machinum.workspace;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@RequiredArgsConstructor
public class WorkspaceLayout {

  public static final String MT_DIR = ".mt";

  public static final String SCRIPTS_DIR = "scripts";

  public static final String TOOLS_CACHE_DIR = "tools";

  public static final String STATE_DIR = "state";

  public static final String SRC_DIR = "src";

  public static final String MAIN_DIR = "main";

  public static final String CHAPTERS_DIR = "chapters";

  public static final String MANIFESTS_DIR = "manifests";

  public static final String BUILD_DIR = "build";

  public static final List<String> SCRIPT_SUBDIRS =
      List.of("conditions", "transformers", "validators", "loaders", "extractors");

  private final Path workspaceRoot;

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public ValidationResult validate() {
    ValidationResult result = new ValidationResult();
    result.setValid(true);

    List<Path> requiredDirs = List.of(
        workspaceRoot.resolve(MT_DIR),
        workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR),
        workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR),
        workspaceRoot.resolve(BUILD_DIR));

    for (Path dir : requiredDirs) {
      if (!Files.exists(dir)) {
        result.getMissingDirectories().add(dir);
        result.setValid(false);
      }
    }

    Path scriptsDir = workspaceRoot.resolve(MT_DIR).resolve(SCRIPTS_DIR);
    if (Files.exists(scriptsDir)) {
      for (String subdir : SCRIPT_SUBDIRS) {
        Path scriptSubdir = scriptsDir.resolve(subdir);
        if (!Files.exists(scriptSubdir)) {
          result.getMissingDirectories().add(scriptSubdir);
        }
      }
    }

    log.debug("Workspace validation complete: valid={}", result.isValid());
    return result;
  }

  public void createDirectories() throws IOException {
    log.info("Creating workspace structure in {}", workspaceRoot);

    Path mtDir = workspaceRoot.resolve(MT_DIR);
    Files.createDirectories(mtDir);
    Files.createDirectories(mtDir.resolve(SCRIPTS_DIR));
    for (String subdir : SCRIPT_SUBDIRS) {
      createWithGitkeep(mtDir.resolve(SCRIPTS_DIR).resolve(subdir));
    }
    Files.createDirectories(mtDir.resolve(TOOLS_CACHE_DIR));
    Files.createDirectories(mtDir.resolve(STATE_DIR));

    Path chaptersDir = workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR);
    Files.createDirectories(chaptersDir);
    createWithGitkeep(chaptersDir.resolve("en"));

    Path manifestsDir = workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR);
    Files.createDirectories(manifestsDir);

    Files.createDirectories(workspaceRoot.resolve(BUILD_DIR));

    log.info("Workspace structure created successfully");
  }

  public Path getMtDir() {
    return workspaceRoot.resolve(MT_DIR);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public Path getScriptsDir() {
    return workspaceRoot.resolve(MT_DIR).resolve(SCRIPTS_DIR);
  }

  public Path getStateDir() {
    return workspaceRoot.resolve(MT_DIR).resolve(STATE_DIR);
  }

  public Path getChaptersDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR);
  }

  public Path getManifestsDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR);
  }

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public Path getBuildDir() {
    return workspaceRoot.resolve(BUILD_DIR);
  }

  private void createWithGitkeep(Path dir) throws IOException {
    Files.createDirectories(dir);
    Path gitkeep = dir.resolve(".gitkeep");
    if (!Files.exists(gitkeep)) {
      Files.writeString(gitkeep, "");
    }
  }

  @Data
  @NoArgsConstructor
  public static class ValidationResult {

    private boolean valid;
    private List<Path> missingDirectories = new ArrayList<>();
  }
}
