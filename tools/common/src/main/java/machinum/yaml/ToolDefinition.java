package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ToolDefinition(
    String name,
    String type,
    String description,
    @JsonAlias("config") @Singular("config") Map<String, Object> toolConfig,
    String script) {

  public boolean isInternal() {
    return "internal".equalsIgnoreCase(type);
  }

  public boolean isExternal() {
    return "external".equalsIgnoreCase(type);
  }
}
