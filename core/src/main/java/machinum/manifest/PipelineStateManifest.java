package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
public record PipelineStateManifest(
    String name,
    String description,
    String condition,
    @JsonAlias("tools") @Singular List<ToolManifest> stateTools) {}
