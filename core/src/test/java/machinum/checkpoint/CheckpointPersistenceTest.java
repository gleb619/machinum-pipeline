package machinum.checkpoint;

import static machinum.config.CoreConfig.coreConfig;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import machinum.config.SingletonSupport.SingletonScope;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CheckpointPersistenceTest {

  @TempDir
  Path tempDir;

  private CheckpointStore checkpointStore;
  private SingletonScope scope;

  @BeforeEach
  void setUp() {
    scope = SingletonScope.of();
    checkpointStore = coreConfig(scope).checkpointStore(tempDir);
  }

  @Test
  void testSaveAndLoadCheckpoint() throws IOException {
    CheckpointSnapshot snapshot = CheckpointSnapshot.builder()
        .runId("run-123")
        .pipelineName("test-pipeline")
        .lastUpdated(Instant.now())
        .status(CheckpointSnapshot.RunStatus.RUNNING)
        .currentStateIndex(1)
        .currentStateName("state2")
        .itemProgress(List.of(new CheckpointSnapshot.ItemProgress(
            "item-1",
            1,
            "state2",
            CheckpointSnapshot.ItemProgress.ItemStatus.IN_PROGRESS,
            Map.of())))
        .runContext(Map.of())
        .build();

    checkpointStore.save(snapshot);

    assertTrue(checkpointStore.exists("run-123"));

    Optional<CheckpointSnapshot> loaded = checkpointStore.load("run-123");
    assertTrue(loaded.isPresent());
    assertEquals("run-123", loaded.get().runId());
    assertEquals("test-pipeline", loaded.get().pipelineName());
    assertEquals(CheckpointSnapshot.RunStatus.RUNNING, loaded.get().status());
    assertEquals(1, loaded.get().currentStateIndex());
    assertEquals("state2", loaded.get().currentStateName());
  }

  @Test
  void testLoadNonExistentCheckpoint() throws IOException {
    Optional<CheckpointSnapshot> loaded = checkpointStore.load("non-existent");
    assertFalse(loaded.isPresent());
  }

  @Test
  void testDeleteCheckpoint() throws IOException {
    // TODO: redo to builder
    @Deprecated(forRemoval = true)
    CheckpointSnapshot snapshot = new CheckpointSnapshot(
        "run-456",
        "test-pipeline",
        Instant.now(),
        CheckpointSnapshot.RunStatus.COMPLETED,
        2,
        null,
        List.of(),
        Map.of());

    checkpointStore.save(snapshot);
    assertTrue(checkpointStore.exists("run-456"));

    boolean deleted = checkpointStore.delete("run-456");
    assertTrue(deleted);
    assertFalse(checkpointStore.exists("run-456"));
  }

  @Test
  void testDeleteNonExistentCheckpoint() throws IOException {
    boolean deleted = checkpointStore.delete("non-existent");
    assertFalse(deleted);
  }
}
