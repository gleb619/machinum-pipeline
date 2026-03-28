package machinum.pipeline;

import static machinum.config.CoreConfig.coreConfig;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.config.SingletonSupport.Scope;
import machinum.config.SingletonSupport.SingletonScope;
import machinum.tool.InMemoryToolRegistry;
import machinum.yaml.PipelineManifest;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;
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
  void testResumeFromCheckpoint() throws Exception {
    // TODO: redo to builder
    @Deprecated(forRemoval = true)
    PipelineManifest pipeline = new PipelineManifest(
        "test-pipeline",
        "Test pipeline",
        Map.of(),
        new PipelineManifest.SourceOrItems(Map.of("file", "items.csv"), null),
        List.of(
            new StateDefinition(
                "state1",
                null,
                null,
                List.of(new ToolDefinition("tool1", "internal", null, null, null)),
                null),
            new StateDefinition(
                "state2",
                null,
                null,
                List.of(new ToolDefinition("tool1", "internal", null, null, null)),
                null),
            new StateDefinition(
                "state3",
                null,
                null,
                List.of(new ToolDefinition("tool1", "internal", null, null, null)),
                null)),
        List.of());

    InMemoryToolRegistry registry = coreConfig(scope).inMemoryToolRegistry();
    registry.registerAll(List.of(new ToolDefinition("tool1", "internal", "Test tool", null, null)));

    String runId = "resume-test-1";

    PipelineStateMachine stateMachine =
        coreConfig(scope).pipelineStateMachine(runId, checkpointDir, pipeline);

    stateMachine.execute();

    assertTrue(checkpointStore.exists(runId));

    CheckpointSnapshot snapshot = checkpointStore.load(runId).orElseThrow();
    assertEquals(CheckpointSnapshot.RunStatus.COMPLETED, snapshot.status());
    assertEquals(3, snapshot.currentStateIndex());
  }

  @Test
  void testNoCheckpointForInvalidRunId() throws Exception {
    String invalidRunId = "invalid-run";

    assertFalse(checkpointStore.exists(invalidRunId));

    var loaded = checkpointStore.load(invalidRunId);
    assertFalse(loaded.isPresent());
  }
}
