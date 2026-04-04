package machinum.bootstrap;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
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
}
