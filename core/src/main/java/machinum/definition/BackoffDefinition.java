package machinum.definition;

import java.time.Duration;
import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.manifest.PipelineBody;

@Builder
public record BackoffDefinition(
    Compiled<PipelineBody.BackoffType> type,
    Compiled<Duration> initialDelay,
    Compiled<Duration> maxDelay,
    Compiled<Double> multiplier,
    Compiled<Double> jitter) {}
