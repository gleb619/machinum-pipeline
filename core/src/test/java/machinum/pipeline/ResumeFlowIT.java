package machinum.pipeline;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import machinum.checkpoint.CheckpointSnapshot;
import machinum.checkpoint.CheckpointStore;
import machinum.checkpoint.FileCheckpointStore;
import machinum.tool.InMemoryToolRegistry;
import machinum.yaml.PipelineManifest;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Integration tests for resume flow behavior. */
class ResumeFlowIT {

  @TempDir Path tempDir;

  private CheckpointStore checkpointStore;

  @BeforeEach
  void setUp() {
    checkpointStore = FileCheckpointStore.of(tempDir.resolve("state"));
  }

  @Test
  void testResumeFromCheckpoint() throws Exception {
    //TODO: redo to builder
    @Deprecated(forRemoval = true)
    PipelineManifest pipeline =
        new PipelineManifest(
            "test-pipeline",
            "Test pipeline",
            Map.of(),
            new PipelineManifest.SourceOrItems("items.csv", null),
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

    InMemoryToolRegistry registry = InMemoryToolRegistry.builder().build();
    registry.registerAll(List.of(new ToolDefinition("tool1", "internal", "Test tool", null, null)));

    String runId = "resume-test-1";

    PipelineStateMachine stateMachine =
        PipelineStateMachine.of(runId, pipeline, registry, checkpointStore);

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
