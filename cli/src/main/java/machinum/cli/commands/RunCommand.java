package machinum.cli.commands;

import java.nio.file.Path;
import java.util.concurrent.Callable;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

@Command(name = "run", description = "Run a pipeline")
public class RunCommand implements Callable<Integer> {

  @Option(
      names = {"-p", "--pipeline"},
      description = "Pipeline name",
      required = true)
  private String pipeline;

  @Option(
      names = {"-w", "--workspace"},
      description = "Workspace directory",
      defaultValue = ".")
  private String workspace;

  @Option(
      names = {"--resume"},
      description = "Resume from checkpoint")
  private boolean resume;

  @Option(
      names = {"--run-id"},
      description = "Run identifier")
  private String runId;

  @Option(
      names = {"--dry-run"},
      description = "Validate only, do not execute")
  private boolean dryRun;

  @Override
  public Integer call() throws Exception {
    Path workspaceDir = Path.of(workspace).toAbsolutePath();
    Path checkpointDir = workspaceDir.resolve(".mt/state");

    // TODO: rewrite class from scratch

    return 0;
  }
}
