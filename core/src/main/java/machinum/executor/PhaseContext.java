package machinum.executor;

@FunctionalInterface
public interface PhaseContext {

  LifecyclePhase[] getPhases();

  static PhaseContext empty(LifecyclePhase... phases) {
    return () -> phases;
  }

  enum LifecyclePhase {
    FIND,
    COMPILE,
    DOWNLOAD,
    BOOTSTRAP,
    AFTER_BOOTSTRAP,
    CHECK,
    RUN,
    // TODO: Change state in executor to pause, if task wasn't completed
    PAUSE,
    RESUME,
    SUSPEND,
    COMPLETE
  }

}
