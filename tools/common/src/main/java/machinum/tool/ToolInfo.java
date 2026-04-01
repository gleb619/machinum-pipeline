package machinum.tool;

import lombok.Builder;

@Builder
public record ToolInfo(String name, String description) {}
