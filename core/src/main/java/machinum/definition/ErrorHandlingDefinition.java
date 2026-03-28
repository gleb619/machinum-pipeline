package machinum.definition;

import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;

@Builder
public record ErrorHandlingDefinition(
    Compiled<String> defaultStrategy,
    RetryDefinition retryConfig,
    @Singular List<ErrorStrategyDefinition> strategies) {}
