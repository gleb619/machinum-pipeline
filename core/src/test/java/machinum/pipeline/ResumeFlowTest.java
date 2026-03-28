package machinum.pipeline;

import static machinum.config.CoreConfig.coreConfig;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Path;
import machinum.checkpoint.CheckpointStore;
import machinum.config.SingletonSupport.Scope;
import machinum.config.SingletonSupport.SingletonScope;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ResumeFlowTest {

  @TempDir
  Path tempDir;

  private CheckpointStore checkpointStore;
  private Path checkpointDir;
  private Scope scope;

  @BeforeEach
  void setUp() {
    scope = SingletonScope.of();
    checkpointDir = tempDir.resolve("state");
    checkpointStore = coreConfig(scope).checkpointStore(checkpointDir);
  }

  @Test
  void testNoCheckpointForInvalidRunId() throws Exception {
    String invalidRunId = "invalid-run";

    assertFalse(checkpointStore.exists(invalidRunId));

    var loaded = checkpointStore.load(invalidRunId);
    assertFalse(loaded.isPresent());
  }
}
