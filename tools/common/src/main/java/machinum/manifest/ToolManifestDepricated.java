package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
// TODO: Add custom deserializer for short declaration form
public record ToolManifestDepricated(
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
