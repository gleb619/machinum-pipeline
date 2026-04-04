package machinum.executor.lifecycle;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import machinum.executor.PhaseContext;
import machinum.pipeline.ExecutionContext;

@Data
@AllArgsConstructor
@Builder(toBuilder = true)
public class ExecutionPhaseContext implements PhaseContext {

  private ExecutionContext context;

  @Override
  public LifecyclePhase[] getPhases() {
    return new LifecyclePhase[] {
      LifecyclePhase.RUN, LifecyclePhase.PAUSE, LifecyclePhase.RESUME, LifecyclePhase.SUSPEND,
    };
  }
}
