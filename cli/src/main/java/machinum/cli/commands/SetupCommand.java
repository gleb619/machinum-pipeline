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
    subcommands = {
      SetupCommand.DownloadCommand.class,
      SetupCommand.BootstrapCommand.class,
      SetupCommand.AfterBootstrapCommand.class
    },
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
    Path workspaceDir = resolveWorkspace();
    log.info("Setting workspace up in {} (download + bootstrap)", workspaceDir);

    var executor = CoreConfig.coreConfig().executor(workspaceDir);

    executor
        .chain(workspaceDir)
        .findManifests()
        .setDefaults()
        .compileManifests()
        .executeDownload()
        .executeBootstrap(force)
        .executeAfterBootstrap();

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
      Path workspaceDir = parent.resolveWorkspace();
      log.info("Downloading tool sources to {}", workspaceDir);

      var executor = CoreConfig.coreConfig().executor(workspaceDir);

      executor
          .chain(workspaceDir)
          .findManifests()
          .setDefaults()
          .compileManifests()
          .executeDownload();

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
      Path workspaceDir = parent.resolveWorkspace();
      boolean effectiveForce = force || parent.force;
      log.info("Bootstrapping workspace in {} (force={})", workspaceDir, effectiveForce);

      var executor = CoreConfig.coreConfig().executor(workspaceDir);

      executor
          .chain(workspaceDir)
          .findManifests()
          .setDefaults()
          .compileManifests()
          .executeBootstrap(effectiveForce)
          .executeAfterBootstrap();

      log.info("Bootstrap complete!");
      return 0;
    }
  }

  @Command(
      name = "after-bootstrap",
      description =
          "Run afterBootstrap() phase separately for tools that create files affecting compilation",
      mixinStandardHelpOptions = true)
  static class AfterBootstrapCommand implements Callable<Integer> {

    @ParentCommand
    private SetupCommand parent;

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
      Path workspaceDir = workspace != null
          ? Paths.get(workspace).toAbsolutePath().normalize()
          : parent.resolveWorkspace();
      log.info("Running after bootstrap phase in {}", workspaceDir);

      var executor = CoreConfig.coreConfig().executor(workspaceDir);

      executor
          .chain(workspaceDir)
          .findManifests()
          .setDefaults()
          .compileManifests()
          .executeAfterBootstrap();

      log.info("After bootstrap complete!");
      return 0;
    }
  }

  Path resolveWorkspace() {
    return Paths.get(Objects.requireNonNullElse(workspace, "")).toAbsolutePath().normalize();
  }
}
