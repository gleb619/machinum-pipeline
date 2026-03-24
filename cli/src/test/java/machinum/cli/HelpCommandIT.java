package machinum.cli;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;
import picocli.CommandLine;

/** Smoke test for help command. */
class HelpCommandIT {

  @Test
  void testHelpCommand() {
    MachinumCli cli = new MachinumCli();
    CommandLine commandLine = new CommandLine(cli);

    int exitCode = commandLine.execute("help");

    assertEquals(0, exitCode, "Help command should succeed");
  }

  @Test
  void testMainCommand() {
    MachinumCli cli = new MachinumCli();
    CommandLine commandLine = new CommandLine(cli);

    int exitCode = commandLine.execute();

    assertEquals(0, exitCode, "Main command should succeed");
  }
}
