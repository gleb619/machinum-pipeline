package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.ToolsBody.ToolDefinitionManifest;

@Builder
public record ToolsStateManifest(
    String name,
    String description,
    String condition,
    @JsonAlias("tools") @Singular List<ToolDefinitionManifest> stateTools) {}
