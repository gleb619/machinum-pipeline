package machinum.tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.GitAPIException;

@Slf4j
public class GitTool implements Tool {

  private static final String GITHOOKS_DIR = ".githooks";
  private static final String COMMIT_MSG_HOOK = "commit-msg.sh";

  @Override
  public void bootstrap(BootstrapContext context) {
    Path workspaceRoot = context.getWorkspaceRoot();

    try {
      initializeGitRepository(workspaceRoot);
      createGitHook(workspaceRoot);
    } catch (Exception e) {
      log.error("Failed to bootstrap Git tool", e);
      throw new RuntimeException("Failed to bootstrap Git tool: " + e.getMessage(), e);
    }
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    String message = (String) context.get("commitMessage", "feat: update");
    Path workspaceRoot = Path.of("").normalize().toAbsolutePath();

    try (Git git = Git.open(workspaceRoot.toFile())) {
      git.add().addFilepattern(".").call();
      git.commit().setMessage(message).call();

      log.info("Commit created: {}", message);
      return ToolResult.success(Map.of("commitMessage", message));
    } catch (GitAPIException | IOException e) {
      log.error("Failed to create commit", e);
      return ToolResult.failure("Failed to create commit: " + e.getMessage());
    }
  }

  private void initializeGitRepository(Path workspaceRoot) throws GitAPIException {
    Path gitDir = workspaceRoot.resolve(".git");

    if (Files.notExists(gitDir)) {
      log.info("Initializing Git repository in {}", workspaceRoot);
      try (Git _ = Git.init().setDirectory(workspaceRoot.toFile()).call()) {
        log.info("Git repository initialized");
      }
    } else {
      log.debug("Git repository already exists in {}", workspaceRoot);
    }
  }

  private void createGitHook(Path workspaceRoot) throws IOException {
    Path githooksDir = workspaceRoot.resolve(GITHOOKS_DIR);
    Files.createDirectories(githooksDir);

    Path commitMsgHook = githooksDir.resolve(COMMIT_MSG_HOOK);
    if (Files.notExists(commitMsgHook)) {
      String hookContent = loadCommitMsgHookContent();
      Files.writeString(commitMsgHook, hookContent);
      commitMsgHook.toFile().setExecutable(true);
      log.info("Created git commit-msg hook: {}", commitMsgHook);

      configureGitHooksPath(workspaceRoot);
    } else {
      log.debug("Git commit-msg hook already exists");
    }
  }

  private String loadCommitMsgHookContent() throws IOException {
    Path projectHook = Path.of(".githooks", COMMIT_MSG_HOOK);
    if (Files.exists(projectHook)) {
      log.debug("Loading commit-msg hook from project: {}", projectHook);
      return Files.readString(projectHook);
    }

    log.debug("Using inline commit-msg hook content");
    //TODO: Add to resources folder
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

  private void configureGitHooksPath(Path workspaceRoot) throws IOException {
    try (Git git = Git.open(workspaceRoot.toFile())) {
      git.getRepository().getConfig().setString("core", null, "hooksPath", GITHOOKS_DIR);
      git.getRepository().getConfig().save();
      log.info("Configured git core.hooksPath to {}", GITHOOKS_DIR);
    } catch (IOException e) {
      log.error("Failed to configure git hooks path", e);
      throw e;
    }
  }

  @Override
  public ToolInfo info() {
    return ToolInfo.builder()
        .name("git")
        .description("Git repository management - initializes repo and creates commits with GitLab convention")
        .build();
  }
}
