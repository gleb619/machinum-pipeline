package machinum.executor.lifecycle;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import machinum.bootstrap.BootstrapContext;
import machinum.executor.PhaseContext;

@Data
@AllArgsConstructor
@Builder(toBuilder = true)
public class BootstrapPhaseContext implements PhaseContext {

  private BootstrapContext context;

  @Override
  public LifecyclePhase[] getPhases() {
    return new LifecyclePhase[] {LifecyclePhase.BOOTSTRAP, LifecyclePhase.AFTER_BOOTSTRAP};
  }
}
