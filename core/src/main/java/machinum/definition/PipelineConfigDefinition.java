package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;

@Builder
public record PipelineConfigDefinition(
    Compiled<Integer> batchSize,
    Compiled<Integer> windowBatchSize,
    Compiled<String> cooldown,
    Compiled<Boolean> allowOverrideMode,
    PipelineExecutionDefinition execution) {}
