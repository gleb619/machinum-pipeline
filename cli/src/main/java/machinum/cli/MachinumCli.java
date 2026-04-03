package machinum.cli;

import java.util.concurrent.Callable;
import machinum.cli.commands.CleanupCommand;
import machinum.cli.commands.HelpCommand;
import machinum.cli.commands.LogsCommand;
import machinum.cli.commands.RunCommand;
import machinum.cli.commands.SetupCommand;
import machinum.cli.commands.StatusCommand;
import picocli.CommandLine;
import picocli.CommandLine.Command;

@Command(
    name = "machinum",
    mixinStandardHelpOptions = true,
    versionProvider = MachinumCli.class,
    subcommands = {
      SetupCommand.class,
      CleanupCommand.class,
      RunCommand.class,
      StatusCommand.class,
      LogsCommand.class,
      HelpCommand.class
    })
public class MachinumCli implements Callable<Integer>, CommandLine.IVersionProvider {

  @Override
  // TODO: use build info to take info from gradle
  @Deprecated
  public Integer call() {
    var version = new MachinumCli().getVersion()[0];
    System.out.printf("""
        Machinum Pipeline CLI v%s

        Use 'machinum help' for available commands.
        %n""", version);
    return 0;
  }

  public static void main(String[] args) {
    CommandLine commandLine = new CommandLine(new MachinumCli());
    int exitCode = commandLine.execute(args);
    System.exit(exitCode);
  }

  @Override
  public String[] getVersion() {
    return new String[] {"0.1.0"};
  }
}
