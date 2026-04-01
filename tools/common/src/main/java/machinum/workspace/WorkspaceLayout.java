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
@Data
@RequiredArgsConstructor
public class WorkspaceLayout {

  public static final String WORK_DIR = ".mt";

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

  public ValidationResult validate() {
    ValidationResult result = new ValidationResult();
    result.setValid(true);

    if (!Files.exists(workspaceRoot)) {
      try {
        Files.createDirectories(workspaceRoot);
      } catch (Exception e) {
        result.setValid(false);
        log.error("Cannot create workspace root: {}", workspaceRoot, e);
      }
    }

    if (!Files.isWritable(workspaceRoot)) {
      result.setValid(false);
      log.error("Workspace root is not writable: {}", workspaceRoot);
    }

    log.debug("Workspace validation complete: valid={}", result.isValid());
    return result;
  }

  public Path getWorkDir() {
    return workspaceRoot.resolve(WORK_DIR);
  }

  public Path getScriptsDir() {
    return getWorkDir().resolve(SCRIPTS_DIR);
  }

  public List<Path> getScriptsDirs() {
    return SCRIPT_SUBDIRS.stream()
        .map(subdir -> getWorkDir().resolve(WorkspaceLayout.SCRIPTS_DIR).resolve(subdir))
        .toList();
  }

  public Path getStateDir() {
    return getWorkDir().resolve(STATE_DIR);
  }

  public Path getChaptersDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(CHAPTERS_DIR);
  }

  public Path getManifestsDir() {
    return workspaceRoot.resolve(SRC_DIR).resolve(MAIN_DIR).resolve(MANIFESTS_DIR);
  }

  public Path getToolsCacheDir() {
    return getWorkDir().resolve(TOOLS_CACHE_DIR);
  }

  public Path getBuildDir() {
    return workspaceRoot.resolve(BUILD_DIR);
  }

  public void createWithGitkeep(Path dir) throws IOException {
    Files.createDirectories(dir);
    Path gitkeep = dir.resolve(".gitkeep");
    if (!Files.exists(gitkeep)) {
      Files.writeString(gitkeep, "");
    }
  }

  public void createGitHook(Path workspaceRoot) throws IOException {
    Path githooksDir = workspaceRoot.resolve(".githooks");
    Files.createDirectories(githooksDir);

    Path commitMsgHook = githooksDir.resolve("commit-msg.sh");
    if (Files.notExists(commitMsgHook)) {
      String hookContent = loadCommitMsgHookContent();
      Files.writeString(commitMsgHook, hookContent);
      commitMsgHook.toFile().setExecutable(true);
      log.info("Created git commit-msg hook: {}", commitMsgHook);
    } else {
      log.debug("Git commit-msg hook already exists");
    }
  }

  private String loadCommitMsgHookContent() throws IOException {
    Path projectHook = Path.of(".githooks", "commit-msg.sh");
    if (Files.exists(projectHook)) {
      log.debug("Loading commit-msg hook from project: {}", projectHook);
      return Files.readString(projectHook);
    }

    log.debug("Using inline commit-msg hook content");

    //TODO: Move to resources
    return """
        #!/usr/bin/env bash

        commit_msg_file="$1"
        commit_msg="$(head -n1 "$commit_msg_file")"

        allowed_pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?(!)?: .+$'

        if [[ ! "$commit_msg" =~ $allowed_pattern ]]; then
          cat >&2 <<'EOF'
        ERROR: Invalid commit message format.

        Expected format:
          <type>(<scope>): <subject>
          or
          <type>!: <subject>

        Allowed types:
          feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

        Example:
          feat(auth): add jwt authentication support
          fix!: resolve memory leak issue
        EOF
          exit 1
        fi
        """;
  }

  @Data
  @NoArgsConstructor
  public static class ValidationResult {

    private boolean valid;
    private List<Path> missingDirectories = new ArrayList<>();
  }
}
