---
name: java-cli-command
description: Create Picocli-based CLI commands following Machinum Pipeline patterns. Use when working with CLI commands, command-line interfaces, or Picocli annotations.
---

# Java CLI Command Skill

## Instructions

Create Picocli-based CLI commands that follow the Machinum Pipeline project patterns established in `HelpCommand.java`.

### Command Structure Pattern

Follow this exact structure for new commands:

```java
package machinum.cli.commands;

import java.util.concurrent.Callable;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/** Command to [brief description]. */
@Command(name = "command-name", description = "Show in --help")
public class CommandName implements Callable<Integer> {

  @Option(
      names = {"-o", "--option"},
      description = "Option description")
  private String option;

  @Override
  public Integer call() {
    // Command implementation
    System.out.println("Command executed");
    return 0; // Success exit code
  }
}
```

### Key Requirements

1. **Package**: Always use `machinum.cli.commands`
2. **Interface**: Implement `Callable<Integer>`
3. **Annotations**: Use `@Command` and `@Option` from Picocli
4. **Return**: Return `0` for success, non-zero for errors
5. **Description**: Provide clear, concise descriptions for help text

### Test Structure Pattern

Create corresponding test in `cli/src/test/java/machinum/cli/`:

```java
package machinum.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import picocli.CommandLine;

/** Test for [CommandName]. */
class CommandNameTest {

  @Test
  void testCommandExecution() {
    MachinumCli cli = new MachinumCli();
    CommandLine commandLine = new CommandLine(cli);

    int exitCode = commandLine.execute("command-name");

    assertEquals(0, exitCode, "Command should succeed");
  }
}
```

### Command Registration

Register new commands in `MachinumCli.java` using `@Command` subcommands annotation.

### Common Patterns

- **Help commands**: Follow `HelpCommand.java:17-34` pattern for output formatting
- **Status commands**: Return structured JSON or formatted text
- **File operations**: Use proper path validation and error handling
- **Configuration**: Load from YAML following project patterns

## Examples

See `HelpCommand.java:1-38` and `HelpCommandTest.java:1-31` for reference implementations.

## Templates

Use the templates in `templates/` directory for consistent structure.

## References

- Picocli documentation for advanced options
- Project's existing commands for patterns
- `docs/tdd.md` for TDD requirements
