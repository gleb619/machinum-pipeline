package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.manifest.PipelineBody;

@Builder
public record BackoffDefinition(
    Compiled<PipelineBody.BackoffType> type,
    Compiled<String> initialDelay,
    Compiled<String> maxDelay,
    Compiled<Double> multiplier,
    Compiled<Double> jitter) {}
