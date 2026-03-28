package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ToolsManifest(
    String name,
    String version,
    @JsonAlias("tools") @Singular("tool") List<ToolDefinition> tools,
    @JsonAlias("config") @Singular("config") Map<String, Object> toolConfig) {}
