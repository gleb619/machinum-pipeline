package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;

@Builder
public record RetryDefinition(Compiled<Integer> maxAttempts, BackoffDefinition backoff) {}
