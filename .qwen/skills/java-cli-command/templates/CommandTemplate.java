package machinum.cli.commands;

import java.util.concurrent.Callable;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/**
 * Command to [brief description].
 */
@Command(name = "command-name", description = "Show in --help")
public class CommandName implements Callable<Integer> {

  @Option(
      names = {"-o", "--option"},
      description = "Option description")
  private String option;

  @Override
  public Integer call() {
    // TODO: Implement command logic
    System.out.println("Command executed with option: " + option);
    return 0;
  }
}
