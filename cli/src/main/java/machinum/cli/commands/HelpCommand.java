package machinum.cli.commands;

import java.util.concurrent.Callable;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

@Command(name = "help", description = "Show help information")
public class HelpCommand implements Callable<Integer> {

  @Option(
      names = {"-c", "--command"},
      description = "Show help for a specific command")
  private String command;

  @Override
  public Integer call() {
    if (command != null) {
      System.out.println("Help for command: " + command);
    } else {
      System.out.println("""
          Machinum Pipeline CLI

          Usage: machinum <command> [options]

          Commands:
            run       Run a pipeline
            status    Show run status
            logs      Show run logs
            help      Show this help message

          Use 'machinum help --command <name>' for more details on a command.
          """);
    }
    return 0;
  }
}
