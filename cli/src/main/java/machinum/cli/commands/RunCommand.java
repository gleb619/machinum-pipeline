package machinum.cli.commands;

import java.nio.file.Path;
import java.util.concurrent.Callable;
import machinum.checkpoint.CheckpointStore;
import machinum.checkpoint.FileCheckpointStore;
import machinum.cli.RuntimeConfigLoader;
import machinum.pipeline.PipelineStateMachine;
import machinum.tool.InMemoryToolRegistry;
import machinum.yaml.PipelineManifest;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/** Command to run a pipeline. */
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

    RuntimeConfigLoader configLoader = RuntimeConfigLoader.of();
    var config = configLoader.load(workspaceDir);

    PipelineManifest pipelineManifest = configLoader.loadPipeline(workspaceDir, pipeline);

    System.out.println("Loaded pipeline: " + pipelineManifest.name());
    System.out.println("States: " + pipelineManifest.pipelineStates().size());

    if (dryRun) {
      System.out.println("Dry run - validation successful, not executing");
      return 0;
    }

    InMemoryToolRegistry toolRegistry = InMemoryToolRegistry.builder().build();
    toolRegistry.registerAll(config.tools().tools());

    CheckpointStore checkpointStore = FileCheckpointStore.of(checkpointDir);

    PipelineStateMachine stateMachine =
        PipelineStateMachine.of(runId, pipelineManifest, toolRegistry, checkpointStore);

    stateMachine.execute();

    System.out.println("Pipeline completed. Run ID: " + stateMachine.getRunId());
    return 0;
  }
}
