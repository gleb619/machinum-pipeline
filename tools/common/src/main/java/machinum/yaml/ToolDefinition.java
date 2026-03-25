package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

/** Represents tool metadata and configuration required for tool resolution and execution. */
@Builder
public record ToolDefinition(
    String name,
    String type,
    String description,
    @JsonAlias("config") @Singular("config") Map<String, Object> toolConfig,
    String script) {

  /** Returns true if this is an internal tool (type == "internal"). */
  public boolean isInternal() {
    return "internal".equalsIgnoreCase(type);
  }

  /** Returns true if this is an external tool (type == "external"). */
  public boolean isExternal() {
    return "external".equalsIgnoreCase(type);
  }
}
