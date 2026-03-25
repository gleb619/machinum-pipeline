package machinum.cli.commands;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.Callable;
import lombok.extern.slf4j.Slf4j;
import machinum.workspace.WorkspaceInitializerTool;
import machinum.workspace.WorkspaceLayout;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ParentCommand;

/**
 * Install command: initializes workspace with download and bootstrap phases.
 *
 * <p>Usage:
 *
 * <pre>{@code
 * machinum install                    # Full install (download + bootstrap)
 * machinum install download           # Download only
 * machinum install bootstrap          # Bootstrap only
 * machinum install --force            # Overwrite existing files
 * machinum install --workspace /path  # Specify workspace directory
 * }</pre>
 */
@Slf4j
@Command(
    name = "install",
    description = "Initialize workspace with tool sources and directory structure",
    subcommands = {InstallCommand.DownloadCommand.class, InstallCommand.BootstrapCommand.class},
    mixinStandardHelpOptions = true)
public class InstallCommand implements Callable<Integer> {

  /** Workspace root directory option. */
  @Option(
      names = {"--workspace", "-w"},
      description = "Workspace root directory (default: current directory)",
      paramLabel = "<path>")
  private String workspace;

  /** Force overwrite flag. */
  @Option(
      names = {"--force", "-f"},
      description = "Overwrite existing configuration files")
  private boolean force;

  @Override
  public Integer call() throws Exception {
    Path workspaceRoot = resolveWorkspace();
    log.info("Installing workspace in {}", workspaceRoot);

    WorkspaceLayout layout = new WorkspaceLayout(workspaceRoot);
    WorkspaceInitializerTool initializer = new WorkspaceInitializerTool(workspaceRoot, layout);

    initializer.install(force);

    return 0;
  }

  /**
   * Resolves the workspace root directory.
   *
   * @return the workspace root path
   */
  private Path resolveWorkspace() {
    if (workspace == null) {
      return Paths.get(System.getProperty("user.dir"));
    }
    return Paths.get(workspace).toAbsolutePath().normalize();
  }

  /** Download subcommand: fetches tool sources without workspace mutation. */
  @Command(
      name = "download",
      description = "Download tool sources without creating workspace structure",
      mixinStandardHelpOptions = true)
  static class DownloadCommand implements Callable<Integer> {

    @ParentCommand
    private InstallCommand parent;

    @Override
    public Integer call() throws Exception {
      Path workspaceRoot = parent.resolveWorkspace();
      log.info("Downloading tool sources to {}", workspaceRoot);

      WorkspaceLayout layout = new WorkspaceLayout(workspaceRoot);
      WorkspaceInitializerTool initializer = new WorkspaceInitializerTool(workspaceRoot, layout);

      initializer.download();

      log.info("Download complete");
      return 0;
    }
  }

  /** Bootstrap subcommand: creates workspace structure and generates files. */
  @Command(
      name = "bootstrap",
      description = "Create workspace structure and generate configuration files",
      mixinStandardHelpOptions = true)
  static class BootstrapCommand implements Callable<Integer> {

    @ParentCommand
    private InstallCommand parent;

    @Override
    //TODO: we need to start here another state machine process
    @Deprecated(forRemoval = true)
    public Integer call() throws Exception {
      Path workspaceRoot = parent.resolveWorkspace();
      log.info("Bootstrapping workspace in {}", workspaceRoot);

      WorkspaceLayout layout = new WorkspaceLayout(workspaceRoot);
      WorkspaceInitializerTool initializer = new WorkspaceInitializerTool(workspaceRoot, layout);

      initializer.bootstrap(parent.force);

      log.info("Bootstrap complete!");
      return 0;
    }
  }
}
