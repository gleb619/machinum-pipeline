package machinum.cli.commands;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.util.concurrent.Callable;
import machinum.checkpoint.CheckpointStore;
import machinum.pipeline.PipelineStateMachine;
import machinum.pipeline.RuntimeConfigLoader;
import machinum.tool.InMemoryToolRegistry;
import machinum.yaml.PipelineManifest;
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

    RuntimeConfigLoader configLoader = coreConfig().runtimeConfigLoader();
    var config = configLoader.load(workspaceDir);

    PipelineManifest pipelineManifest = configLoader.loadPipeline(workspaceDir, pipeline);

    System.out.printf(
        """
            Loaded pipeline: %s
            States: %d""", pipelineManifest.name(), pipelineManifest.pipelineStates().size());

    if (dryRun) {
      System.out.println("Dry run - validation successful, not executing");
      return 0;
    }

    InMemoryToolRegistry toolRegistry = coreConfig().inMemoryToolRegistry();
    toolRegistry.registerAll(config.tools().tools());

    CheckpointStore checkpointStore = coreConfig().fileCheckpointStore(checkpointDir);

    if (resume) {
      if (runId == null) {
        System.err.println("Error: --run-id is required when using --resume");
        return 1;
      }

      if (!checkpointStore.exists(runId)) {
        System.err.printf("""
            Error: No checkpoint found for run: %s

            Cannot resume without existing checkpoint%n""", runId);
        return 1;
      }

      PipelineStateMachine stateMachine =
          coreConfig().pipelineStateMachine(runId, checkpointDir, pipelineManifest);

      stateMachine.resume();

      System.out.println("Pipeline resumed and completed. Run ID: " + stateMachine.getRunId());
    } else {
      PipelineStateMachine stateMachine =
          coreConfig().pipelineStateMachine(runId, checkpointDir, pipelineManifest);

      stateMachine.execute();

      System.out.println("Pipeline completed. Run ID: " + stateMachine.getRunId());
    }

    return 0;
  }
}
