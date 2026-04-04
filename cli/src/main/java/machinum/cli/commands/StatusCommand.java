package machinum.cli.commands;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.util.concurrent.Callable;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

@Command(name = "status", description = "Show run status")
public class StatusCommand implements Callable<Integer> {

  @Option(
      names = {"--run-id"},
      description = "Run identifier",
      required = true)
  private String runId;

  @Option(
      names = {"-w", "--workspace"},
      description = "Workspace directory",
      defaultValue = ".")
  private String workspace;

  @Override
  @Deprecated
  public Integer call() throws Exception {
    Path workspaceDir = Path.of(workspace).toAbsolutePath();
    // TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead of
    // hardcode
    Path checkpointDir = workspaceDir.resolve(".mt/state");

    CheckpointStore checkpointStore = coreConfig().fileCheckpointStore(checkpointDir);

    if (!checkpointStore.exists(runId)) {
      System.err.println("No checkpoint found for run: " + runId);
      return 1;
    }

    CheckpointSnapshot snapshot = checkpointStore
        .load(runId)
        .orElseThrow(() -> new IllegalStateException("Checkpoint not found"));

    System.out.printf(
        """
            Run ID: %s
            Pipeline: %s
            Status: %s
            Current State: %s (index: %d)
            Last Updated: %s
            %n""",
        snapshot.runId(),
        snapshot.pipelineName(),
        snapshot.status(),
        snapshot.currentStateName(),
        snapshot.currentStateIndex(),
        snapshot.lastUpdated());

    return 0;
  }
}
