package machinum.definition;

import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;

@Builder
public record ToolDefinition(
    Compiled<String> name,
    Compiled<String> description,
    Compiled<Boolean> async,
    Compiled<String> input,
    Compiled<String> output,
    @Singular List<ToolDefinition> tools) {}
