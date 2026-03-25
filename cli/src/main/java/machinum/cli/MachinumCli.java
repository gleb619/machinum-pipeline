package machinum.cli;

import java.util.concurrent.Callable;
import machinum.cli.commands.HelpCommand;
import machinum.cli.commands.LogsCommand;
import machinum.cli.commands.RunCommand;
import machinum.cli.commands.StatusCommand;
import picocli.CommandLine;
import picocli.CommandLine.Command;

/** Main CLI entry point. */
@Command(
    name = "machinum",
    mixinStandardHelpOptions = true,
    version = "0.1.0",
    subcommands = {RunCommand.class, StatusCommand.class, LogsCommand.class, HelpCommand.class})
public class MachinumCli implements Callable<Integer> {

  @Override
  public Integer call() {
    System.out.println("""
        Machinum Pipeline CLI v0.1.0

        Use 'machinum help' for available commands.
        """);
    return 0;
  }

  public static void main(String[] args) {
    CommandLine commandLine = new CommandLine(new MachinumCli());
    int exitCode = commandLine.execute(args);
    System.exit(exitCode);
  }
}
