package machinum.definition;

import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.compiler.Compiled;

@Builder
public record PipelineStateDefinition(
    Compiled<String> name,
    Compiled<String> description,
    Compiled<String> condition,
    @Singular List<ToolDefinition> stateTools) {}
