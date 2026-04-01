package machinum.bootstrap;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.ToString;

@Data
@AllArgsConstructor
@Builder(toBuilder = true)
public class BootstrapContext {

  @Builder.Default
  private Path workspaceRoot = Path.of("").normalize().toAbsolutePath();

  @Builder.Default
  @ToString.Exclude
  private Map<String, String> secrets = new HashMap<>();

  @Builder.Default
  private Map<String, Object> data = new HashMap<>();

  @Builder.Default
  private Boolean force = Boolean.FALSE;

  public Optional<Object> getVariable(String name) {
    return Optional.ofNullable(data.get(name));
  }

  public Optional<String> getEnvironment(String name) {
    return Optional.ofNullable(secrets.get(name));
  }

  public Object getVariable(String name, Object defaultValue) {
    return data.getOrDefault(name, defaultValue);
  }

  public String getEnvironment(String name, String defaultValue) {
    return secrets.getOrDefault(name, defaultValue);
  }
}
