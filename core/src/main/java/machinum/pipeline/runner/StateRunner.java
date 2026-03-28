package machinum.pipeline.runner;

import machinum.pipeline.ExecutionContext;
import machinum.yaml.StateDefinition;

public interface StateRunner {

  void executeState(StateDefinition state, int stateIndex, String itemId, ExecutionContext context)
      throws Exception;
}
