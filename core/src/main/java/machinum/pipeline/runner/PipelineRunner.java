package machinum.pipeline.runner;

import machinum.definition.PipelineStateDefinition;
import machinum.pipeline.ExecutionContext;

public interface PipelineRunner {

  void executeState(
      PipelineStateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception;
}
