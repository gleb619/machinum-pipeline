package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record StateDefinition(
    String name,
    String description,
    String condition,
    @JsonAlias("tools") @Singular("tool") List<ToolDefinition> stateTools,
    @JsonAlias("config") @Singular("config") Map<String, Object> stateConfig) {}
