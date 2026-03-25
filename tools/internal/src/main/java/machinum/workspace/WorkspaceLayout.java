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

/**
 * Defines and validates the workspace directory structure for Machinum Pipeline.
 *
 * <p>Standard layout:
 *
 * <pre>{@code
 * workspace-root/
 * ├── .mt/                          # Internal directory
 * │   ├── tools.yaml                # Tool definitions
 * │   ├── scripts/                  # External scripts
 * │   │   ├── conditions/
 * │   │   ├── transformers/
 * │   │   ├── validators/
 * │   │   ├── loaders/
 * │   │   └── extractors/
 * │   ├── tools/                    # Tool cache
 * │   └── state/                    # Checkpoint state
 * │       └── {run-id}/
 * ├── src/
 * │   └── main/
 * │       ├── chapters/             # Input payloads
 * │       │   └── en/               # Language tag
 * │       └── manifests/            # Pipeline declarations
 * └── build/                        # Output artifacts
 * }</pre>
 */
@Slf4j
@RequiredArgsConstructor
public class WorkspaceLayout {

  /** Internal directory name. */
  public static final String MT_DIR = ".mt";

  /** Scripts subdirectory. */
  public static final String SCRIPTS_DIR = "scripts";

  /** Tool cache subdirectory. */
  public static final String TOOLS_CACHE_DIR = "tools";

  /** State subdirectory. */
  public static final String STATE_DIR = "state";

  /** Source directory. */
  public static final String SRC_DIR = "src";

  /** Main source directory. */
  public static final String MAIN_DIR = "main";

  /** Chapters input directory. */
  public static final String CHAPTERS_DIR = "chapters";

  /** Manifests directory. */
  public static final String MANIFESTS_DIR = "manifests";

  /** Build output directory. */
  public static final String BUILD_DIR = "build";

  /** Script type subdirectories. */
  public static final List<String> SCRIPT_SUBDIRS =
      List.of("conditions", "transformers", "validators", "loaders", "extractors");

  /** Workspace root directory. */
  private final Path workspaceRoot;

  /**
   * Validates the workspace structure.
   *
   * @return validation result with any missing directories
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public ValidationResult validate() {
    ValidationResult result = new ValidationResult();
    result.setValid(true);

    // Check required directories
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

    // Check scripts subdirectories if .mt/scripts exists
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

  /**
   * Creates all required directories.
   *
   * @throws IOException if directory creation fails
   */
  public void createDirectories() throws IOException {
    log.info("Creating workspace structure in {}", workspaceRoot);

    // Create .mt and subdirectories
    Path mtDir = workspaceRoot.resolve(MT_DIR);
    Files.createDirectories(mtDir);
    Files.createDirectories(mtDir.resolve(SCRIPTS_DIR));
    for (String subdir : SCRIPT_SUBDIRS) {
      createWithGitkeep(mtDir.resolve(SCRIPTS_DIR).resolve(subdir));
    }
    Files.createDirectories(mtDir.resolve(TOOLS_CACHE_DIR));
    Files.createDirectories(mtDir.resolve(STATE_DIR));

    // Create src/main/chapters
    Path chaptersDir = workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR);
    Files.createDirectories(chaptersDir);
    createWithGitkeep(chaptersDir.resolve("en"));

    // Create src/main/manifests
    Path manifestsDir = workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR);
    Files.createDirectories(manifestsDir);

    // Create build
    Files.createDirectories(workspaceRoot.resolve(BUILD_DIR));

    log.info("Workspace structure created successfully");
  }

  /**
   * Gets the .mt directory path.
   *
   * @return the .mt directory
   */
  public Path getMtDir() {
    return workspaceRoot.resolve(MT_DIR);
  }

  /**
   * Gets the scripts directory path.
   *
   * @return the scripts directory
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Path getScriptsDir() {
    return workspaceRoot.resolve(MT_DIR).resolve(SCRIPTS_DIR);
  }

  /**
   * Gets the state directory path.
   *
   * @return the state directory
   */
  public Path getStateDir() {
    return workspaceRoot.resolve(MT_DIR).resolve(STATE_DIR);
  }

  /**
   * Gets the chapters directory path.
   *
   * @return the chapters directory
   */
  public Path getChaptersDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR);
  }

  /**
   * Gets the manifests directory path.
   *
   * @return the manifests directory
   */
  public Path getManifestsDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR);
  }

  /**
   * Gets the build directory path.
   *
   * @return the build directory
   */
  //TODO: Unused
  @Deprecated(forRemoval = true)
  public Path getBuildDir() {
    return workspaceRoot.resolve(BUILD_DIR);
  }

  /**
   * Creates a directory with a .gitkeep file.
   *
   * @param dir the directory to create
   * @throws IOException if creation fails
   */
  private void createWithGitkeep(Path dir) throws IOException {
    Files.createDirectories(dir);
    Path gitkeep = dir.resolve(".gitkeep");
    if (!Files.exists(gitkeep)) {
      Files.writeString(gitkeep, "");
    }
  }

  /** Result of workspace validation. */
  @Data
  @NoArgsConstructor
  public static class ValidationResult {
    private boolean valid;
    private List<Path> missingDirectories = new ArrayList<>();
  }
}
