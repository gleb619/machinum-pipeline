package machinum.pipeline;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import machinum.ToolRegistry;
import machinum.checkpoint.CheckpointStore;
import machinum.config.SingletonSupport.SingletonScope;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.io.TempDir;

class SequentialRunnerTest {

  @TempDir
  Path tempDir;

  private ToolRegistry toolRegistry;
  private CheckpointStore checkpointStore;
  private Path checkpointDir;
  private SingletonScope scope;

  @BeforeEach
  void setUp() {
    scope = SingletonScope.of();
    toolRegistry = coreConfig(scope).inMemoryToolRegistry();
    checkpointDir = tempDir.resolve("state");
    checkpointStore = coreConfig(scope).checkpointStore(checkpointDir);
  }
}
