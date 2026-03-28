package machinum.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import picocli.CommandLine;

/**
 * Test for [CommandName].
 */
class CommandNameTest {

  @Test
  void testCommandExecution() {
    MachinumCli cli = new MachinumCli();
    CommandLine commandLine = new CommandLine(cli);

    int exitCode = commandLine.execute("command-name");

    assertEquals(0, exitCode, "Command should succeed");
  }

  @Test
  void testCommandWithOptions() {
    MachinumCli cli = new MachinumCli();
    CommandLine commandLine = new CommandLine(cli);

    int exitCode = commandLine.execute("command-name", "--option", "value");

    assertEquals(0, exitCode, "Command with options should succeed");
  }
}
