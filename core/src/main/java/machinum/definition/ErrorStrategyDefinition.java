package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.manifest.PipelineBody;

@Builder
public record ErrorStrategyDefinition(
    Compiled<String> exception, Compiled<PipelineBody.ErrorStrategy> strategy) {}
