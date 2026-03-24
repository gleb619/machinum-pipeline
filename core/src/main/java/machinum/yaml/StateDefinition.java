package machinum.yaml;

import java.util.List;
import java.util.Map;

/** Represents one pipeline state with optional condition and one or more tool declarations. */
public record StateDefinition(
    String name,
    String description,
    String condition,
    List<ToolDefinition> tools,
    Map<String, Object> config) {}
