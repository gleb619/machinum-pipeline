package machinum.workspace;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.workspace.WorkspaceLayout.ValidationResult;

@Slf4j
@RequiredArgsConstructor
public class FolderStructureHelper {

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

  public boolean isInitialized(WorkspaceLayout layout) {
    return Files.exists(layout.getWorkDir())
        && Files.exists(layout.getChaptersDir())
        && Files.exists(layout.getManifestsDir());
  }

  public void createGitHook(WorkspaceLayout layout) throws IOException {
    layout.createGitHook(layout.getWorkspaceRoot());
  }

  public ValidationResult validate(WorkspaceLayout layout) {
    return layout.validate();
  }
}
