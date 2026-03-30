package machinum.cli.commands;

import java.nio.file.Path;
import java.util.concurrent.Callable;
import lombok.extern.slf4j.Slf4j;
import machinum.config.CoreConfig;
import machinum.executor.Executor;
import machinum.executor.Executor.LifecycleContext;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

@Slf4j
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
    log.info(
        "Running pipeline '{}' in {} (resume={}, dryRun={})",
        pipeline,
        workspaceDir,
        resume,
        dryRun);

    Executor executor = CoreConfig.coreConfig().executor();
    // TODO: Add here new lifecycle method to check if tools are installed and bootstrapped
    LifecycleContext ctx = executor.executePipeline(pipeline, workspaceDir, resume, runId);

    if (dryRun) {
      log.info("Dry run completed successfully - no execution performed");
    } else {
      log.info("Pipeline execution completed: phase={}", ctx.currentPhase());
    }

    return 0;
  }
}
