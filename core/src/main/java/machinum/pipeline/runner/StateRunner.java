package machinum.pipeline.runner;

import machinum.definition.PipelineStateDefinition;
import machinum.pipeline.ExecutionContext;

public interface StateRunner {

  void executeState(
      PipelineStateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception;
}
