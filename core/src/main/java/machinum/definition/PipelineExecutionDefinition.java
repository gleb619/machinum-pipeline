package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;

@Builder
public record PipelineExecutionDefinition(
    Compiled<Boolean> manifestSnapshotEnabled,
    Compiled<String> manifestSnapshotMode,
    Compiled<String> mode,
    Compiled<Integer> maxConcurrency) {}
