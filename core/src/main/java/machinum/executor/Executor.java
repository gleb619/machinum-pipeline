package machinum.executor;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@RequiredArgsConstructor
public class Executor {

  private final SeedExecutor seedExecutor;
  private final ToolsExecutor toolsExecutor;
  private final PipelineExecutor pipelineExecutor;

  // TODO:
}
