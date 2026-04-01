package machinum.cli.commands;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Objects;
import java.util.concurrent.Callable;
import lombok.extern.slf4j.Slf4j;
import machinum.config.CoreConfig;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ParentCommand;

@Slf4j
@Command(
    name = "setup",
    description =
        "Initialize workspace with tool sources and directory structure. Shortcut for: download + bootstrap",
    subcommands = {SetupCommand.DownloadCommand.class, SetupCommand.BootstrapCommand.class},
    mixinStandardHelpOptions = true)
public class SetupCommand implements Callable<Integer> {

  @Option(
      names = {"--workspace", "-w"},
      description = "Workspace root directory (default: current directory)",
      paramLabel = "<path>")
  private String workspace;

  @Option(
      names = {"--force", "-f"},
      description = "Overwrite existing configuration files")
  private boolean force;

  @Override
  public Integer call() {
    Path workspaceRoot = resolveWorkspace();
    log.info("Setting workspace up in {} (download + bootstrap)", workspaceRoot);

    var executor = CoreConfig.coreConfig().executor();

    executor.chain(workspaceRoot).findManifests()
        .executeDownload()
        .executeBootstrap(force);

    log.info("Setup complete!");

    return 0;
  }

  @Command(
      name = "download",
      description = "Download tool sources without creating workspace structure",
      mixinStandardHelpOptions = true)
  static class DownloadCommand implements Callable<Integer> {

    @ParentCommand
    private SetupCommand parent;

    @Override
    public Integer call() {
      Path workspaceRoot = parent.resolveWorkspace();
      log.info("Downloading tool sources to {}", workspaceRoot);

      var executor = CoreConfig.coreConfig().executor();

      executor.chain(workspaceRoot).findManifests().executeDownload();

      log.info("Download complete!");
      return 0;
    }
  }

  @Command(
      name = "bootstrap",
      description = "Create workspace structure and run bootstrap() on all internal tools",
      mixinStandardHelpOptions = true)
  static class BootstrapCommand implements Callable<Integer> {

    @ParentCommand
    private SetupCommand parent;

    @Option(
        names = {"--force", "-f"},
        description = "Overwrite existing configuration files")
    private boolean force;

    @Override
    public Integer call() {
      Path workspaceRoot = parent.resolveWorkspace();
      log.info("Bootstrapping workspace in {}", workspaceRoot);

      var executor = CoreConfig.coreConfig().executor();

      executor.chain(workspaceRoot).findManifests().executeBootstrap(force);

      log.info("Bootstrap complete!");
      return 0;
    }
  }

  Path resolveWorkspace() {
    return Paths.get(
        Objects.requireNonNullElse(workspace, ""))
        .toAbsolutePath().normalize();
  }
}
