package machinum.pipeline;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import machinum.checkpoint.CheckpointStore;
import machinum.checkpoint.FileCheckpointStore;
import machinum.tool.InMemoryToolRegistry;
import machinum.tool.ToolRegistry;
import machinum.yaml.PipelineManifest;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Integration tests for sequential state execution. */
class SequentialRunnerIT {

  @TempDir Path tempDir;

  private ToolRegistry toolRegistry;
  private CheckpointStore checkpointStore;

  @BeforeEach
  void setUp() {
    toolRegistry = InMemoryToolRegistry.builder().build();
    checkpointStore = FileCheckpointStore.of(tempDir.resolve("state"));
  }

  @Test
  void testSequentialStateExecution() throws Exception {
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
                    null)),
            List.of());

    InMemoryToolRegistry registry = InMemoryToolRegistry.builder().build();
    registry.registerAll(List.of(new ToolDefinition("tool1", "internal", "Test tool", null, null)));

    PipelineStateMachine stateMachine =
        PipelineStateMachine.of(pipeline, registry, checkpointStore);

    stateMachine.execute();

    assertEquals(PipelineStateMachine.RunState.COMPLETED, stateMachine.getRunState());
    assertEquals(2, stateMachine.getCurrentStateIndex());
  }

  @Test
  void testStateConditionSkip() throws Exception {
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
                    "false",
                    List.of(new ToolDefinition("tool1", "internal", null, null, null)),
                    null)),
            List.of());

    InMemoryToolRegistry registry = InMemoryToolRegistry.builder().build();
    registry.registerAll(List.of(new ToolDefinition("tool1", "internal", "Test tool", null, null)));

    PipelineStateMachine stateMachine =
        PipelineStateMachine.of(pipeline, registry, checkpointStore);

    stateMachine.execute();

    assertEquals(PipelineStateMachine.RunState.COMPLETED, stateMachine.getRunState());
    assertEquals(1, stateMachine.getCurrentStateIndex());
  }

  @Test
  void testMissingToolFails() {
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
                    List.of(new ToolDefinition("missing-tool", "internal", null, null, null)),
                    null)),
            List.of());

    InMemoryToolRegistry registry = InMemoryToolRegistry.builder().build();

    PipelineStateMachine stateMachine =
        PipelineStateMachine.of(pipeline, registry, checkpointStore);

    assertThrows(IllegalStateException.class, stateMachine::execute);
    assertEquals(PipelineStateMachine.RunState.FAILED, stateMachine.getRunState());
  }
}
